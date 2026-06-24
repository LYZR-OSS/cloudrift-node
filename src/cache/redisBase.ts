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
 */
import { CacheError, CloudRiftError } from "../core/errors.js";
import {
  CacheBackend,
  type CachePipeline,
  type CacheReadValue,
  type CacheValue,
  type ExpireOptions,
} from "./base.js";

export interface RedisPipelineLike {
  set(...args: unknown[]): unknown;
  getBuffer(key: string): unknown;
  del(...keys: string[]): unknown;
  incr(key: string): unknown;
  expire(...args: unknown[]): unknown;
  sadd(key: string, ...members: CacheValue[]): unknown;
  srem(key: string, ...members: CacheValue[]): unknown;
  exec(): Promise<unknown[] | null>;
}

export interface RedisClientLike {
  getBuffer(key: string): Promise<Buffer | null>;
  set(...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists(key: string): Promise<number>;
  expire(...args: unknown[]): Promise<number>;
  ttl(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  scanBuffer(...args: unknown[]): Promise<[Buffer | string, Buffer[]]>;
  getdelBuffer(key: string): Promise<Buffer | null>;
  hgetBuffer(key: string, field: string): Promise<Buffer | null>;
  hset(key: string, field: string, value: CacheValue): Promise<number>;
  hgetallBuffer(key: string): Promise<Record<string, Buffer>>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  sadd(key: string, ...members: CacheValue[]): Promise<number>;
  srem(key: string, ...members: CacheValue[]): Promise<number>;
  scard(key: string): Promise<number>;
  sismember(key: string, member: CacheValue): Promise<number>;
  smembersBuffer(key: string): Promise<Buffer[]>;
  sinterBuffer(...keys: string[]): Promise<Buffer[]>;
  lpush(key: string, ...values: CacheValue[]): Promise<number>;
  rpush(key: string, ...values: CacheValue[]): Promise<number>;
  lrangeBuffer(key: string, start: number, stop: number): Promise<Buffer[]>;
  llen(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  mgetBuffer(...keys: string[]): Promise<Array<Buffer | null>>;
  mset(mapping: Record<string, CacheValue>): Promise<unknown>;
  ping(): Promise<string>;
  flushdb(): Promise<unknown>;
  quit(): Promise<unknown>;
  multi(): RedisPipelineLike;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  options: {
    password?: string;
  };
}

export interface RedisOptionsLike {
  host?: string;
  port?: number;
  db?: number;
  username?: string;
  password?: string;
  tls?: unknown;
}

/**
 * Wrap an unknown thrown value as a `CacheError`, preserving the original via
 * `cause`. Used as `catch (e) { throw toCacheError(e); }`.
 */
function toCacheError(e: unknown): CacheError {
  const message = e instanceof Error ? e.message : String(e);
  return new CacheError(message, { cause: e });
}

/**
 * Resolve the optional `expire` flag into the Redis `"NX"`/`"XX"` argument, or
 * `undefined` when neither is set. Throws if both are requested — `nx` and `xx`
 * are mutually exclusive (Python raises `ValueError`; here `CloudRiftError`).
 */
function expireFlag(opts?: ExpireOptions): "NX" | "XX" | undefined {
  const nx = opts?.nx ?? false;
  const xx = opts?.xx ?? false;
  if (nx && xx) {
    throw new CloudRiftError("expire() flags `nx` and `xx` are mutually exclusive");
  }
  if (nx) return "NX";
  if (xx) return "XX";
  return undefined;
}

/**
 * Pipeline wrapper over an ioredis `ChainableCommander` (a MULTI transaction).
 *
 * Queues commands and runs them on `exec()`. Translates an EXEC-level failure
 * into a `CacheError`; per-command errors are returned in the result tuples by
 * ioredis (parity with redis-py raising on `execute()`).
 */
class RedisPipeline implements CachePipeline {
  constructor(private readonly multi: RedisPipelineLike) {}

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

  expire(key: string, seconds: number, opts?: { nx?: boolean; xx?: boolean }): this {
    const flag = expireFlag(opts);
    if (flag) {
      this.multi.expire(key, seconds, flag);
    } else {
      this.multi.expire(key, seconds);
    }
    return this;
  }

  sadd(key: string, ...members: CacheValue[]): this {
    this.multi.sadd(key, ...members);
    return this;
  }

  srem(key: string, ...members: CacheValue[]): this {
    this.multi.srem(key, ...members);
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
  protected readonly client: RedisClientLike;
  /**
   * When `true`, byte values read back from Redis are decoded to UTF-8 strings
   * before being returned (mirrors redis-py's `decode_responses`). Default
   * `false` keeps the cache-backend contract of returning `Buffer`.
   */
  protected readonly decodeResponses: boolean;

  constructor(client: RedisClientLike, decodeResponses = false) {
    super();
    this.client = client;
    this.decodeResponses = decodeResponses;
  }

  /** Decode a single Buffer read per the `decodeResponses` flag. */
  private decode(value: Buffer | null): CacheReadValue | null {
    if (value === null) return null;
    return this.decodeResponses ? value.toString("utf-8") : value;
  }

  /** Decode an array of Buffer reads per the `decodeResponses` flag. */
  private decodeMany(values: Buffer[]): CacheReadValue[] {
    return this.decodeResponses ? values.map((v) => v.toString("utf-8")) : values;
  }

  async get(key: string): Promise<CacheReadValue | null> {
    try {
      return this.decode(await this.client.getBuffer(key));
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

  async expire(key: string, seconds: number, opts?: ExpireOptions): Promise<boolean> {
    // `expireFlag` validates nx/xx mutual exclusion before any client call.
    const flag = expireFlag(opts);
    try {
      const result = flag
        ? await this.client.expire(key, seconds, flag)
        : await this.client.expire(key, seconds);
      return result === 1;
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

  async scan(cursor = 0, match?: string, count?: number): Promise<[number, CacheReadValue[]]> {
    // Build the positional args ioredis expects: SCAN cursor [MATCH p] [COUNT c].
    const args: unknown[] = [cursor];
    if (match !== undefined) {
      args.push("MATCH", match);
    }
    if (count !== undefined) {
      args.push("COUNT", count);
    }
    try {
      const [nextCursor, foundKeys] = await this.client.scanBuffer(...args);
      // ioredis returns the cursor as a string (Buffer via scanBuffer); coerce
      // to a number to mirror Python's `int(next_cursor)`.
      const cursorStr = typeof nextCursor === "string" ? nextCursor : nextCursor.toString();
      return [Number(cursorStr), this.decodeMany(foundKeys)];
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async getdel(key: string): Promise<CacheReadValue | null> {
    try {
      return this.decode(await this.client.getdelBuffer(key));
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async hget(key: string, field: string): Promise<CacheReadValue | null> {
    try {
      return this.decode(await this.client.hgetBuffer(key, field));
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

  async hgetall(key: string): Promise<Record<string, CacheReadValue>> {
    try {
      const raw = await this.client.hgetallBuffer(key);
      if (!this.decodeResponses) return raw;
      const decoded: Record<string, CacheReadValue> = {};
      for (const [field, value] of Object.entries(raw)) {
        decoded[field] = value.toString("utf-8");
      }
      return decoded;
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

  async sadd(key: string, ...members: CacheValue[]): Promise<number> {
    try {
      return await this.client.sadd(key, ...members);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async srem(key: string, ...members: CacheValue[]): Promise<number> {
    try {
      return await this.client.srem(key, ...members);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async scard(key: string): Promise<number> {
    try {
      return await this.client.scard(key);
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async sismember(key: string, member: CacheValue): Promise<boolean> {
    try {
      return (await this.client.sismember(key, member)) === 1;
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async smembers(key: string): Promise<CacheReadValue[]> {
    try {
      return this.decodeMany(await this.client.smembersBuffer(key));
    } catch (e) {
      throw toCacheError(e);
    }
  }

  async sinter(...keys: string[]): Promise<CacheReadValue[]> {
    if (keys.length === 0) {
      throw new CloudRiftError("sinter() requires at least one key");
    }
    try {
      return this.decodeMany(await this.client.sinterBuffer(...keys));
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

  async lrange(key: string, start: number, stop: number): Promise<CacheReadValue[]> {
    try {
      return this.decodeMany(await this.client.lrangeBuffer(key, start, stop));
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

  async mget(...keys: string[]): Promise<Array<CacheReadValue | null>> {
    try {
      const raw = await this.client.mgetBuffer(...keys);
      return this.decodeResponses ? raw.map((v) => this.decode(v)) : raw;
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
