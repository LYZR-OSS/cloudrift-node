/**
 * AWS ElastiCache (Redis) backend.
 *
 * Mirrors `cloudrift-py`'s `AWSElastiCacheBackend`. Construct via one of:
 *  - `fromAuthToken` — Redis AUTH token (ElastiCache auth token / password)
 *  - `fromIamAuth`   — IAM-based authentication (ElastiCache Redis 7+, SigV4)
 *  - `fromTlsCert`   — mTLS with client certificate and key files
 *
 * IAM auth: a short-lived SigV4 presigned-URL token (15-min expiry) is used as
 * the Redis password. The Python implementation refreshes the token on every
 * new connection via a redis-py `CredentialProvider`. ioredis has no equivalent
 * per-connection credential callback (its `password` is a fixed string), so we
 * regenerate the token and reassign `client.options.password` from a
 * `reconnectOnError`/`beforeConnect`-style hook so each (re)connection picks up
 * a fresh token. See `attachIamTokenRefresh` below for the exact mechanism and
 * its limitations.
 */
import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";

import type { AwsCredentialIdentity } from "@smithy/types";
import type { RedisOptions, Redis as RedisDefault } from "ioredis";

import { CacheConnectionError } from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { BaseRedisBackend } from "./redisBase.js";

type RedisModule = { default: new (options: RedisOptions) => RedisDefault };

async function loadRedis(): Promise<RedisModule["default"]> {
  const mod = await loadOptional<RedisModule>("ioredis", "elasticache");
  return mod.default;
}

function buildTls(opts: {
  sslCaCerts?: string;
  sslCertfile?: string;
  sslKeyfile?: string;
}): ConnectionOptions | undefined {
  const tls: ConnectionOptions = {};
  let any = false;
  if (opts.sslCaCerts) {
    tls.ca = readFileSync(opts.sslCaCerts);
    any = true;
  }
  if (opts.sslCertfile) {
    tls.cert = readFileSync(opts.sslCertfile);
    any = true;
  }
  if (opts.sslKeyfile) {
    tls.key = readFileSync(opts.sslKeyfile);
    any = true;
  }
  return any ? tls : undefined;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface IamTokenParams {
  host: string;
  port: number;
  username: string;
  region: string;
  credentials: AwsCredentialIdentity;
}

/**
 * Generate a short-lived SigV4-signed token for ElastiCache IAM auth.
 *
 * Replicates the Python `_generate_iam_token`: it signs a presigned `GET`
 * request to `https://{host}:{port}/?Action=connect&User={username}` for the
 * `elasticache` service with a 900-second (15-min) expiry, then returns the
 * signed URL with the `https://` scheme stripped (Redis expects the bare signed
 * URL as the password).
 *
 * Uses `@smithy/signature-v4` (`SignatureV4.presign`) with the AWS-JS SHA-256
 * hash so the produced query string carries `X-Amz-Algorithm`,
 * `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-Expires`, `X-Amz-SignedHeaders` and
 * `X-Amz-Signature` — the same shape boto3's `SigV4QueryAuth` emits.
 */
export async function generateElastiCacheIamToken(params: IamTokenParams): Promise<string> {
  const { SignatureV4 } = await loadOptional<typeof import("@smithy/signature-v4")>(
    "@smithy/signature-v4",
    "elasticache",
  );
  const { Sha256 } = await loadOptional<typeof import("@aws-crypto/sha256-js")>(
    "@aws-crypto/sha256-js",
    "elasticache",
  );

  const signer = new SignatureV4({
    service: "elasticache",
    region: params.region,
    credentials: params.credentials,
    sha256: Sha256,
  });

  // Construct the request to presign. The query carries the connect action and
  // the Redis ACL username, exactly like the Python AWSRequest URL.
  const request = {
    method: "GET",
    protocol: "https:",
    hostname: params.host,
    port: params.port,
    path: "/",
    query: {
      Action: "connect",
      User: params.username,
    },
    headers: {
      host: `${params.host}:${params.port}`,
    },
  };

  const presigned = await signer.presign(request, { expiresIn: 900 });

  // Reassemble the query string and strip the scheme, matching
  // `request.url.replace("https://", "", 1)` in Python.
  const query = presigned.query ?? {};
  const queryString = Object.keys(query)
    .map((k) => {
      const v = query[k];
      const value = Array.isArray(v) ? v.join(",") : (v ?? "");
      return `${encodeURIComponent(k)}=${encodeURIComponent(value)}`;
    })
    .join("&");

  return `${params.host}:${params.port}/?${queryString}`;
}

/**
 * Resolve AWS credentials for IAM-token signing, honoring explicit access keys
 * or a named profile, otherwise falling back to the default provider chain.
 */
async function resolveCredentials(opts: {
  region: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  profileName?: string;
}): Promise<AwsCredentialIdentity> {
  if (opts.awsAccessKeyId && opts.awsSecretAccessKey) {
    return {
      accessKeyId: opts.awsAccessKeyId,
      secretAccessKey: opts.awsSecretAccessKey,
      ...(opts.awsSessionToken ? { sessionToken: opts.awsSessionToken } : {}),
    };
  }
  const providers = await loadOptional<typeof import("@aws-sdk/credential-providers")>(
    "@aws-sdk/credential-providers",
    "elasticache",
  );
  if (opts.profileName) {
    return providers.fromIni({ profile: opts.profileName })();
  }
  return providers.fromNodeProviderChain()();
}

export class AWSElastiCacheBackend extends BaseRedisBackend {
  /**
   * Connect using an ElastiCache AUTH token (shared secret).
   *
   * @param opts.port default 6379, @param opts.db default 0,
   * @param opts.ssl  default true (transit encryption).
   */
  static async fromAuthToken(opts: {
    host: string;
    port?: number;
    authToken?: string;
    db?: number;
    ssl?: boolean;
    sslCaCerts?: string;
  }): Promise<AWSElastiCacheBackend> {
    try {
      const Redis = await loadRedis();
      const ssl = opts.ssl ?? true;
      const options: RedisOptions = {
        host: opts.host,
        port: opts.port ?? 6379,
        db: opts.db ?? 0,
      };
      if (opts.authToken !== undefined) options.password = opts.authToken;
      if (ssl) {
        options.tls = buildTls({ sslCaCerts: opts.sslCaCerts }) ?? {};
      }
      const client = new Redis(options);
      return new AWSElastiCacheBackend(client);
    } catch (e) {
      throw new CacheConnectionError(`Failed to connect to ElastiCache: ${describe(e)}`, {
        cause: e,
      });
    }
  }

  /**
   * Connect using IAM-based authentication (ElastiCache Redis 7+ with IAM).
   *
   * A short-lived SigV4 token is generated at connection time and refreshed on
   * reconnect (see `attachIamTokenRefresh`).
   *
   * @param opts.port default 6379, @param opts.db default 0,
   * @param opts.ssl  default true (required for IAM auth).
   */
  static async fromIamAuth(opts: {
    host: string;
    username: string;
    region: string;
    port?: number;
    db?: number;
    ssl?: boolean;
    sslCaCerts?: string;
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    awsSessionToken?: string;
    profileName?: string;
  }): Promise<AWSElastiCacheBackend> {
    try {
      const Redis = await loadRedis();
      const port = opts.port ?? 6379;
      const ssl = opts.ssl ?? true;
      const credentials = await resolveCredentials({
        region: opts.region,
        awsAccessKeyId: opts.awsAccessKeyId,
        awsSecretAccessKey: opts.awsSecretAccessKey,
        awsSessionToken: opts.awsSessionToken,
        profileName: opts.profileName,
      });

      const genToken = (): Promise<string> =>
        generateElastiCacheIamToken({
          host: opts.host,
          port,
          username: opts.username,
          region: opts.region,
          credentials,
        });

      const initialToken = await genToken();

      const options: RedisOptions = {
        host: opts.host,
        port,
        db: opts.db ?? 0,
        username: opts.username,
        password: initialToken,
      };
      if (ssl) {
        options.tls = buildTls({ sslCaCerts: opts.sslCaCerts }) ?? {};
      }
      const client = new Redis(options);
      attachIamTokenRefresh(client, genToken);
      return new AWSElastiCacheBackend(client);
    } catch (e) {
      throw new CacheConnectionError(`Failed to connect to ElastiCache (IAM): ${describe(e)}`, {
        cause: e,
      });
    }
  }

  /**
   * Connect using mutual TLS (mTLS) with a client certificate and key.
   *
   * @param opts.port default 6380.
   */
  static async fromTlsCert(opts: {
    host: string;
    port?: number;
    authToken?: string;
    db?: number;
    sslCertfile: string;
    sslKeyfile: string;
    sslCaCerts?: string;
  }): Promise<AWSElastiCacheBackend> {
    try {
      const Redis = await loadRedis();
      const options: RedisOptions = {
        host: opts.host,
        port: opts.port ?? 6380,
        db: opts.db ?? 0,
        tls:
          buildTls({
            sslCaCerts: opts.sslCaCerts,
            sslCertfile: opts.sslCertfile,
            sslKeyfile: opts.sslKeyfile,
          }) ?? {},
      };
      if (opts.authToken !== undefined) options.password = opts.authToken;
      const client = new Redis(options);
      return new AWSElastiCacheBackend(client);
    } catch (e) {
      throw new CacheConnectionError(`Failed to connect to ElastiCache (mTLS): ${describe(e)}`, {
        cause: e,
      });
    }
  }
}

/**
 * Keep the IAM token fresh across reconnects.
 *
 * redis-py re-invokes `CredentialProvider.get_credentials()` on every new
 * connection. ioredis has no such per-connection credential hook; its
 * `options.password` is read at connect time. We approximate the Python
 * behavior by regenerating the token whenever the socket closes and writing it
 * back into `client.options.password`, so the next reconnection attempt uses a
 * fresh (non-expired) token. Tokens are valid for 15 minutes, which comfortably
 * covers ioredis's default reconnect backoff window.
 *
 * Limitation: this regenerates on the `close` event rather than synchronously
 * inside the connect handshake; in practice ioredis emits `close` immediately
 * before scheduling a reconnect, so the refreshed password is in place by the
 * time the next connection is opened.
 */
function attachIamTokenRefresh(client: RedisDefault, genToken: () => Promise<string>): void {
  client.on("close", () => {
    genToken()
      .then((token) => {
        // `options` is mutable on the live ioredis instance.
        (client.options as { password?: string }).password = token;
      })
      .catch(() => {
        // Swallow: a failed refresh simply leaves the previous token in place;
        // the reconnect will fail and ioredis will retry, triggering another
        // `close` and another refresh attempt.
      });
  });
}
