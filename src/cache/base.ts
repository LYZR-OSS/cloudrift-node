/**
 * Abstract base class for cloud cache backends.
 *
 * Mirrors `cloudrift-py`'s `cloudrift.cache.base.CacheBackend`. Concrete default
 * methods (`setex`, `healthCheck`, async-dispose) live here; every other op is
 * abstract and implemented by `BaseRedisBackend` over an ioredis instance.
 */

/** A value accepted by write operations: raw bytes or a UTF-8 string. */
export type CacheValue = Buffer | string;

/**
 * A transactional pipeline (Redis MULTI/EXEC) wrapper.
 *
 * Chainable: queue commands, then `exec()` to run them atomically and collect
 * results. Mirrors the Python `pipeline()` async-context-manager, but expressed
 * as an explicit builder (TS has no `async with`).
 */
export interface CachePipeline {
  set(key: string, value: CacheValue, ttl?: number): this;
  get(key: string): this;
  delete(...keys: string[]): this;
  incr(key: string): this;
  /** Execute the queued commands. Returns one entry per queued command. */
  exec(): Promise<unknown[]>;
}

export abstract class CacheBackend {
  /** Return the value for `key`, or `null` if it does not exist. */
  abstract get(key: string): Promise<Buffer | null>;

  /**
   * Set `key` to `value`. `ttl` is the expiry in seconds (`undefined` = no
   * expiry).
   */
  abstract set(key: string, value: CacheValue, ttl?: number): Promise<void>;

  /**
   * Atomic set-with-TTL. Default delegates to `set(key, value, ttl)`.
   */
  async setex(key: string, value: CacheValue, ttl: number): Promise<void> {
    await this.set(key, value, ttl);
  }

  /** Delete one or more keys. Returns the number of keys removed. */
  abstract delete(...keys: string[]): Promise<number>;

  /** Return `true` if `key` exists. */
  abstract exists(key: string): Promise<boolean>;

  /** Set a timeout on `key`. Returns `true` if the timeout was set. */
  abstract expire(key: string, seconds: number): Promise<boolean>;

  /** Return remaining TTL in seconds. -1 = no expiry, -2 = key missing. */
  abstract ttl(key: string): Promise<number>;

  /** Return all keys matching `pattern` (default `"*"`). */
  abstract keys(pattern?: string): Promise<string[]>;

  /** Return the value of `field` in the hash stored at `key`. */
  abstract hget(key: string, field: string): Promise<Buffer | null>;

  /** Set `field` in the hash at `key`. Returns 1 if new, 0 if updated. */
  abstract hset(key: string, field: string, value: CacheValue): Promise<number>;

  /** Return all fields and values of the hash at `key`. */
  abstract hgetall(key: string): Promise<Record<string, Buffer>>;

  /** Delete fields from the hash at `key`. Returns number of fields removed. */
  abstract hdel(key: string, ...fields: string[]): Promise<number>;

  /** Prepend values to the list at `key`. Returns new list length. */
  abstract lpush(key: string, ...values: CacheValue[]): Promise<number>;

  /** Append values to the list at `key`. Returns new list length. */
  abstract rpush(key: string, ...values: CacheValue[]): Promise<number>;

  /** Return the slice [`start`, `stop`] of the list at `key`. */
  abstract lrange(key: string, start: number, stop: number): Promise<Buffer[]>;

  /** Return the length of the list at `key`. */
  abstract llen(key: string): Promise<number>;

  /** Increment the integer value of `key` by 1. Returns the new value. */
  abstract incr(key: string): Promise<number>;

  /** Decrement the integer value of `key` by 1. Returns the new value. */
  abstract decr(key: string): Promise<number>;

  /** Return values for multiple keys at once. */
  abstract mget(...keys: string[]): Promise<Array<Buffer | null>>;

  /** Set multiple key-value pairs at once. */
  abstract mset(mapping: Record<string, CacheValue>): Promise<void>;

  /** Return `true` if the cache server is reachable. */
  abstract ping(): Promise<boolean>;

  /** Flush all keys from the current database. Use with caution. */
  abstract flush(): Promise<void>;

  /** Close the underlying connection pool. */
  abstract close(): Promise<void>;

  /** Return a transactional pipeline (Redis MULTI). */
  abstract pipeline(): CachePipeline;

  /**
   * Return `true` if the cache server is reachable. Default calls `ping()` and
   * swallows any error into `false`.
   */
  async healthCheck(): Promise<boolean> {
    try {
      return await this.ping();
    } catch {
      return false;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
