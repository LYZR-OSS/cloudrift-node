/**
 * Concrete Redis implementation shared by all Redis-backed cache backends.
 *
 * Mirrors `cloudrift-py`'s `_RedisMixin`. Subclasses (standalone, ElastiCache,
 * Azure) differ only in how they construct the underlying ioredis client; every
 * operation is implemented here over that client.
 *
 * All reads use the Buffer-returning ioredis variants (`getBuffer`,
 * `hgetBuffer`, `hgetallBuffer`, `lrangeBuffer`, `mgetBuffer`) so byte values
 * round-trip faithfully — matching redis-py's `decode_responses=False` default.
 *
 * Every operation catches ioredis errors and rethrows them as `CacheError`
 * with the original error attached as `cause`.
 *
 * The `ioredis` package is an optional peer dependency. It is loaded lazily in
 * the provider factory constructors and the constructed client is injected here;
 * this module only type-imports it.
 */
import type { Redis, ChainableCommander } from "ioredis";

import { CacheError } from "../core/errors.js";
import {
  CacheBackend,
  type CachePipeline,
  type CacheValue,
} from "./base.js";

/**
 * Wrap an unknown thrown value as a `CacheError`, preserving the original via
 * `cause`. Used as `catch (e) { throw toCacheError(e); }`.
 */
function toCacheError(e: unknown): CacheError {
  const message = e instanceof Error ? e.message : String(e);
  return new CacheError(message, { cause: e });
}

/**
 * Pipeline wrapper over an ioredis `ChainableCommander` (a MULTI transaction).
 *
 * Queues commands and runs them on `exec()`. Translates an EXEC-level failure
 * into a `CacheError`; per-command errors are returned in the result tuples by
 * ioredis (parity with redis-py raising on `execute()`).
 */
class RedisPipeline implements CachePipeline {
  constructor(private readonly multi: ChainableCommander) {}

  set(key: string, value: CacheValue, ttl?: number): this {
    if (ttl !== undefined && ttl !== null) {
      this.multi.set(key, value, "EX", ttl);
    } else {
      this.multi.set(key, value);
    }
    return this;
  }

  get(key: string): this {
    this.multi.getBuffer(key);
    return this;
  }

  delete(...keys: string[]): this {
    this.multi.del(...keys);
    return this;
  }

  incr(key: string): this {
    this.multi.incr(key);
    return this;
  }

  async exec(): Promise<unknown[]> {
    try {
      const results = await this.multi.exec();
      return results ?? [];
    } catch (e) {
      throw toCacheError(e);
    }
  }
}

/**
 * Base class implementing every `CacheBackend` operation over an ioredis client.
 * Concrete providers pass the constructed `Redis` instance up to this base.
 */
export abstract class BaseRedisBackend extends CacheBackend {
  protected readonly client: Redis;

  constructor(client: Redis) {
    super();
    this.client = client;
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await this.client.getBuffer(key);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async set(key: string, value: CacheValue, ttl?: number): Promise<void> {
    try {
      if (ttl !== undefined && ttl !== null) {
        await this.client.set(key, value, "EX", ttl);
      } else {
        await this.client.set(key, value);
      }
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async delete(...keys: string[]): Promise<number> {
    try {
      if (keys.length === 0) {
        return 0;
      }
      return await this.client.del(...keys);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await this.client.exists(key)) > 0;
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    try {
      return (await this.client.expire(key, seconds)) === 1;
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      return await this.client.ttl(key);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async keys(pattern = "*"): Promise<string[]> {
    try {
      return await this.client.keys(pattern);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async hget(key: string, field: string): Promise<Buffer | null> {
    try {
      return await this.client.hgetBuffer(key, field);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async hset(key: string, field: string, value: CacheValue): Promise<number> {
    try {
      return await this.client.hset(key, field, value);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async hgetall(key: string): Promise<Record<string, Buffer>> {
    try {
      return await this.client.hgetallBuffer(key);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    try {
      if (fields.length === 0) {
        return 0;
      }
      return await this.client.hdel(key, ...fields);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async lpush(key: string, ...values: CacheValue[]): Promise<number> {
    try {
      return await this.client.lpush(key, ...values);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async rpush(key: string, ...values: CacheValue[]): Promise<number> {
    try {
      return await this.client.rpush(key, ...values);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async lrange(key: string, start: number, stop: number): Promise<Buffer[]> {
    try {
      return await this.client.lrangeBuffer(key, start, stop);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async llen(key: string): Promise<number> {
    try {
      return await this.client.llen(key);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async incr(key: string): Promise<number> {
    try {
      return await this.client.incr(key);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async decr(key: string): Promise<number> {
    try {
      return await this.client.decr(key);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async mget(...keys: string[]): Promise<Array<Buffer | null>> {
    try {
      return await this.client.mgetBuffer(...keys);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async mset(mapping: Record<string, CacheValue>): Promise<void> {
    try {
      await this.client.mset(mapping);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async ping(): Promise<boolean> {
    try {
      const reply = await this.client.ping();
      return reply === "PONG";
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async flush(): Promise<void> {
    try {
      await this.client.flushdb();
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch (e) {
      throw toCacheError(e);
    }
  }

  pipeline(): CachePipeline {
    // `multi()` returns a transactional ChainableCommander (Redis MULTI/EXEC),
    // matching the Python `pipeline(transaction=True)`.
    return new RedisPipeline(this.client.multi());
  }
}
