/**
 * Redis backend for self-hosted Redis (e.g. on EC2 or bare-metal).
 *
 * Mirrors `cloudrift-py`'s `StandaloneRedisBackend`. Construct via one of:
 *  - `fromUrl`         — full Redis URL (most flexible)
 *  - `fromCredentials` — host/port + optional password/username/TLS
 *  - `fromTlsCert`     — mTLS with client certificate and key files
 *
 * `ioredis` is loaded lazily inside each factory; connection-setup failures are
 * surfaced as `CacheConnectionError`.
 */
import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";

import type { RedisOptions, Redis as RedisDefault } from "ioredis";

import { CacheConnectionError } from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { BaseRedisBackend } from "./redisBase.js";

/** Minimal shape of the lazily-imported ioredis module's default export. */
type RedisModule = { default: new (options: RedisOptions) => RedisDefault };

/** Load the ioredis constructor lazily (optional peer dependency). */
async function loadRedis(): Promise<RedisModule["default"]> {
  const mod = await loadOptional<RedisModule>("ioredis", "redis");
  return mod.default;
}

/**
 * Build the ioredis TLS `ConnectionOptions` from PEM file paths. Returns
 * `undefined` when no TLS material is supplied (caller decides whether to
 * enable plain TLS via `{}`).
 */
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

export class StandaloneRedisBackend extends BaseRedisBackend {
  /**
   * Connect using a Redis URL, e.g. `redis://user:pass@localhost:6379/0` or
   * `rediss://user:pass@localhost:6380/0` (TLS).
   *
   * @param opts.url        The Redis connection URL.
   * @param opts.sslCaCerts Optional path to the CA certificate bundle (PEM).
   */
  static async fromUrl(opts: {
    url: string;
    sslCaCerts?: string;
  }): Promise<StandaloneRedisBackend> {
    try {
      const Redis = await loadRedis();
      const tls = buildTls({ sslCaCerts: opts.sslCaCerts });
      // ioredis accepts the URL via the `path`-like first arg through options.
      const options: RedisOptions = {};
      if (tls) {
        options.tls = tls;
      }
      const RedisCtor = Redis as unknown as new (
        url: string,
        options: RedisOptions,
      ) => RedisDefault;
      const client = new RedisCtor(opts.url, options);
      return new StandaloneRedisBackend(client);
    } catch (e) {
      throw new CacheConnectionError(`Failed to connect to Redis: ${describe(e)}`, {
        cause: e,
      });
    }
  }

  /**
   * Connect using explicit host, port, and optional credentials.
   *
   * @param opts.port default 6379, @param opts.db default 0,
   * @param opts.ssl  default false.
   */
  static async fromCredentials(opts: {
    host: string;
    port?: number;
    password?: string;
    username?: string;
    db?: number;
    ssl?: boolean;
    sslCaCerts?: string;
  }): Promise<StandaloneRedisBackend> {
    try {
      const Redis = await loadRedis();
      const options: RedisOptions = {
        host: opts.host,
        port: opts.port ?? 6379,
        db: opts.db ?? 0,
      };
      if (opts.password !== undefined) options.password = opts.password;
      if (opts.username !== undefined) options.username = opts.username;
      if (opts.ssl) {
        options.tls = buildTls({ sslCaCerts: opts.sslCaCerts }) ?? {};
      }
      const client = new Redis(options);
      return new StandaloneRedisBackend(client);
    } catch (e) {
      throw new CacheConnectionError(`Failed to connect to Redis: ${describe(e)}`, {
        cause: e,
      });
    }
  }

  /**
   * Connect using mutual TLS (mTLS) with client certificate and key files.
   *
   * @param opts.port default 6380.
   */
  static async fromTlsCert(opts: {
    host: string;
    port?: number;
    password?: string;
    username?: string;
    db?: number;
    sslCertfile: string;
    sslKeyfile: string;
    sslCaCerts?: string;
  }): Promise<StandaloneRedisBackend> {
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
      if (opts.password !== undefined) options.password = opts.password;
      if (opts.username !== undefined) options.username = opts.username;
      const client = new Redis(options);
      return new StandaloneRedisBackend(client);
    } catch (e) {
      throw new CacheConnectionError(`Failed to connect to Redis (mTLS): ${describe(e)}`, {
        cause: e,
      });
    }
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
