/**
 * Azure Cache for Redis backend.
 *
 * Mirrors `cloudrift-py`'s `AzureRedisCacheBackend`. Construct via one of:
 *  - `fromAccessKey`        — primary/secondary access key (standard auth)
 *  - `fromManagedIdentity`  — Azure Managed Identity via Entra ID token auth
 *  - `fromServicePrincipal` — Azure AD service principal via Entra ID token auth
 *
 * Entra auth: an Entra ID access token (`https://redis.azure.com/.default`,
 * ~1-hour validity) is used as the Redis password. The Python implementation
 * refreshes the token on every new connection via a redis-py
 * `CredentialProvider`. ioredis has no per-connection credential callback, so —
 * as for ElastiCache IAM — we regenerate the token on socket close and write it
 * back into `client.options.password` so reconnections use a fresh token.
 */
import type { AccessToken, TokenCredential } from "@azure/identity";
import type { RedisOptions, Redis as RedisDefault } from "ioredis";

import { CacheConnectionError } from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { BaseRedisBackend } from "./redisBase.js";

type RedisModule = { default: new (options: RedisOptions) => RedisDefault };

const REDIS_RESOURCE = "https://redis.azure.com/.default";

async function loadRedis(): Promise<RedisModule["default"]> {
  const mod = await loadOptional<RedisModule>("ioredis", "azure_redis");
  return mod.default;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Fetch an Entra token for the Azure Cache for Redis resource scope. */
async function fetchEntraToken(credential: TokenCredential): Promise<string> {
  const token: AccessToken | null = await credential.getToken(REDIS_RESOURCE);
  if (!token) {
    throw new Error("Entra credential returned no token");
  }
  return token.token;
}

export class AzureRedisCacheBackend extends BaseRedisBackend {
  /**
   * Authenticate with an Azure Cache for Redis access key.
   *
   * @param opts.port default 6380 (SSL), @param opts.db default 0,
   * @param opts.ssl  default true (required for Azure Cache for Redis).
   */
  static async fromAccessKey(opts: {
    host: string;
    accessKey: string;
    port?: number;
    db?: number;
    ssl?: boolean;
  }): Promise<AzureRedisCacheBackend> {
    try {
      const Redis = await loadRedis();
      const ssl = opts.ssl ?? true;
      const options: RedisOptions = {
        host: opts.host,
        port: opts.port ?? 6380,
        db: opts.db ?? 0,
        password: opts.accessKey,
      };
      if (ssl) {
        options.tls = {};
      }
      const client = new Redis(options);
      return new AzureRedisCacheBackend(client);
    } catch (e) {
      throw new CacheConnectionError(`Failed to connect to Azure Cache for Redis: ${describe(e)}`, {
        cause: e,
      });
    }
  }

  /**
   * Authenticate via Azure Managed Identity (Entra ID token auth).
   *
   * @param opts.port default 6380, @param opts.db default 0,
   * @param opts.ssl  default true.
   * @param opts.clientId optional client ID for a user-assigned identity.
   */
  static async fromManagedIdentity(opts: {
    host: string;
    username: string;
    port?: number;
    db?: number;
    ssl?: boolean;
    clientId?: string;
  }): Promise<AzureRedisCacheBackend> {
    try {
      const identity = await loadOptional<typeof import("@azure/identity")>(
        "@azure/identity",
        "azure_redis",
      );
      const credential = opts.clientId
        ? new identity.ManagedIdentityCredential(opts.clientId)
        : new identity.ManagedIdentityCredential();
      return await AzureRedisCacheBackend.connectWithCredential(
        opts,
        credential,
        "Managed Identity",
      );
    } catch (e) {
      if (e instanceof CacheConnectionError) throw e;
      throw new CacheConnectionError(
        `Failed to connect to Azure Cache for Redis (Managed Identity): ${describe(e)}`,
        { cause: e },
      );
    }
  }

  /**
   * Authenticate via Azure AD service principal (Entra ID token auth).
   *
   * @param opts.port default 6380, @param opts.db default 0,
   * @param opts.ssl  default true.
   */
  static async fromServicePrincipal(opts: {
    host: string;
    username: string;
    tenantId: string;
    clientId: string;
    clientSecret: string;
    port?: number;
    db?: number;
    ssl?: boolean;
  }): Promise<AzureRedisCacheBackend> {
    try {
      const identity = await loadOptional<typeof import("@azure/identity")>(
        "@azure/identity",
        "azure_redis",
      );
      const credential = new identity.ClientSecretCredential(
        opts.tenantId,
        opts.clientId,
        opts.clientSecret,
      );
      return await AzureRedisCacheBackend.connectWithCredential(
        opts,
        credential,
        "Service Principal",
      );
    } catch (e) {
      if (e instanceof CacheConnectionError) throw e;
      throw new CacheConnectionError(
        `Failed to connect to Azure Cache for Redis (Service Principal): ${describe(e)}`,
        { cause: e },
      );
    }
  }

  /**
   * Shared Entra-token connect path: fetch the initial token, build the client
   * with `username` + token-as-password, and attach a reconnect refresh hook.
   */
  private static async connectWithCredential(
    opts: {
      host: string;
      username: string;
      port?: number;
      db?: number;
      ssl?: boolean;
    },
    credential: TokenCredential,
    label: string,
  ): Promise<AzureRedisCacheBackend> {
    try {
      const Redis = await loadRedis();
      const ssl = opts.ssl ?? true;
      const initialToken = await fetchEntraToken(credential);
      const options: RedisOptions = {
        host: opts.host,
        port: opts.port ?? 6380,
        db: opts.db ?? 0,
        username: opts.username,
        password: initialToken,
      };
      if (ssl) {
        options.tls = {};
      }
      const client = new Redis(options);
      attachEntraTokenRefresh(client, () => fetchEntraToken(credential));
      return new AzureRedisCacheBackend(client);
    } catch (e) {
      throw new CacheConnectionError(
        `Failed to connect to Azure Cache for Redis (${label}): ${describe(e)}`,
        { cause: e },
      );
    }
  }
}

/**
 * Regenerate the Entra token on socket close and write it back into
 * `client.options.password`, so reconnects use a fresh (non-expired) token.
 * See the ElastiCache equivalent for the rationale and limitations.
 */
function attachEntraTokenRefresh(client: RedisDefault, genToken: () => Promise<string>): void {
  client.on("close", () => {
    genToken()
      .then((token) => {
        (client.options as { password?: string }).password = token;
      })
      .catch(() => {
        /* leave previous token; ioredis will retry and trigger another refresh */
      });
  });
}
