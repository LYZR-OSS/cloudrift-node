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
  /** Queue an `expire` with optional `nx`/`xx` flags. */
  expire(key: string, seconds: number, opts?: { nx?: boolean; xx?: boolean }): this;
  /** Queue a set-add. */
  sadd(key: string, ...members: CacheValue[]): this;
  /** Queue a set-remove. */
  srem(key: string, ...members: CacheValue[]): this;
  /** Execute the queued commands. Returns one entry per queued command. */
  exec(): Promise<unknown[]>;
}

/** Options controlling how `expire` sets a TTL. `nx` and `xx` are mutually exclusive. */
export interface ExpireOptions {
  /** Only set the TTL if the key has no existing TTL. */
  nx?: boolean;
  /** Only set the TTL if the key already has a TTL. */
  xx?: boolean;
}

/**
 * A value returned by read operations. `Buffer` by default; `string` when the
 * backend was constructed with `decodeResponses: true` (mirrors redis-py's
 * `decode_responses`).
 */
export type CacheReadValue = Buffer | string;

export abstract class CacheBackend {
  /** Return the value for `key`, or `null` if it does not exist. */
  abstract get(key: string): Promise<CacheReadValue | null>;

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

  /**
   * Set a timeout on `key`. Returns `true` if the timeout was set.
   *
   * `nx` only sets the TTL when the key has no existing TTL; `xx` only when it
   * already has one. They are mutually exclusive (passing both throws
   * `CloudRiftError`).
   */
  abstract expire(key: string, seconds: number, opts?: ExpireOptions): Promise<boolean>;

  /** Return remaining TTL in seconds. -1 = no expiry, -2 = key missing. */
  abstract ttl(key: string): Promise<number>;

  /** Return all keys matching `pattern` (default `"*"`). */
  abstract keys(pattern?: string): Promise<string[]>;

  /**
   * Incremental keyspace iteration. Returns `[nextCursor, keys]`; iterate until
   * `nextCursor === 0`. Preferred over `keys()` in production (bounded per-call
   * work). Keys are returned as raw bytes (`Buffer`).
   */
  abstract scan(
    cursor?: number,
    match?: string,
    count?: number,
  ): Promise<[number, CacheReadValue[]]>;

  /**
   * Atomically get and delete `key`. Returns the value, or `null` if the key
   * did not exist. Requires Redis >= 6.2.
   */
  abstract getdel(key: string): Promise<CacheReadValue | null>;

  /** Return the value of `field` in the hash stored at `key`. */
  abstract hget(key: string, field: string): Promise<CacheReadValue | null>;

  /** Set `field` in the hash at `key`. Returns 1 if new, 0 if updated. */
  abstract hset(key: string, field: string, value: CacheValue): Promise<number>;

  /** Return all fields and values of the hash at `key`. */
  abstract hgetall(key: string): Promise<Record<string, CacheReadValue>>;

  /** Delete fields from the hash at `key`. Returns number of fields removed. */
  abstract hdel(key: string, ...fields: string[]): Promise<number>;

  /**
   * Add one or more `members` to the set at `key`. Returns the number of
   * members that were newly added (i.e. not already present).
   */
  abstract sadd(key: string, ...members: CacheValue[]): Promise<number>;

  /** Remove one or more `members` from the set at `key`. Returns the number removed. */
  abstract srem(key: string, ...members: CacheValue[]): Promise<number>;

  /** Return the number of elements in the set at `key`. */
  abstract scard(key: string): Promise<number>;

  /** Return `true` if `member` is in the set at `key`. */
  abstract sismember(key: string, member: CacheValue): Promise<boolean>;

  /** Return all members of the set at `key`. */
  abstract smembers(key: string): Promise<CacheReadValue[]>;

  /**
   * Return the members common to all sets at `keys` (set intersection). With a
   * single key this is equivalent to `smembers`. A missing key is treated as an
   * empty set, so any missing key yields an empty result. Requires at least one
   * key (zero keys throws `CloudRiftError`).
   */
  abstract sinter(...keys: string[]): Promise<CacheReadValue[]>;

  /** Prepend values to the list at `key`. Returns new list length. */
  abstract lpush(key: string, ...values: CacheValue[]): Promise<number>;

  /** Append values to the list at `key`. Returns new list length. */
  abstract rpush(key: string, ...values: CacheValue[]): Promise<number>;

  /** Return the slice [`start`, `stop`] of the list at `key`. */
  abstract lrange(key: string, start: number, stop: number): Promise<CacheReadValue[]>;

  /** Return the length of the list at `key`. */
  abstract llen(key: string): Promise<number>;

  /** Increment the integer value of `key` by 1. Returns the new value. */
  abstract incr(key: string): Promise<number>;

  /** Decrement the integer value of `key` by 1. Returns the new value. */
  abstract decr(key: string): Promise<number>;

  /** Return values for multiple keys at once. */
  abstract mget(...keys: string[]): Promise<Array<CacheReadValue | null>>;

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
