/**
 * Redis cache live lifecycle test.
 *
 * Gated on CLOUDRIFT_LIVE_TESTS=1 + CLOUDRIFT_LIVE_REDIS_URL. Uses the public
 * factory getCache("redis", "from_url", { url }). All keys use a unique prefix
 * and are deleted in afterAll; cleanup is wrapped so it never masks a test
 * failure.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getCache } from "../../src/index.js";
import { env, liveLog, requireEnv, uniqueName } from "./env.js";

const REDIS_PRESENT = requireEnv(["CLOUDRIFT_LIVE_REDIS_URL"]);

describe.skipIf(!REDIS_PRESENT)("Redis cache live lifecycle", () => {
  const log = liveLog("redis");
  const prefix = uniqueName("cache");
  const stringKey = `${prefix}:str`;
  const counterKey = `${prefix}:counter`;
  const hashKey = `${prefix}:hash`;
  let backend: Awaited<ReturnType<typeof getCache>> | undefined;

  beforeAll(async () => {
    log.step("initializing backend", { provider: "redis", prefix });
    backend = await getCache("redis", "from_url", {
      url: env("CLOUDRIFT_LIVE_REDIS_URL")!,
    });
  });

  afterAll(async () => {
    try {
      const deleted = await backend?.delete(stringKey, counterKey, hashKey);
      log.step("deleted keys", { prefix, deleted });
    } catch (err) {
      log.warn("cleanup failed", err, { prefix });
    }
    try {
      await backend?.close();
      log.step("closed backend", { prefix });
    } catch (err) {
      log.warn("backend close failed", err, { prefix });
    }
  });

  it("round-trips string (with TTL), incr, and hash ops, and pings", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    log.step("setting string key", { key: stringKey, ttlSeconds: 60 });
    await b.set(stringKey, "cloudrift-live-cache", 60);
    const got = await b.get(stringKey);
    expect(got).not.toBeNull();
    expect(got!.toString("utf8")).toBe("cloudrift-live-cache");
    expect(await b.ttl(stringKey)).toBeGreaterThan(0);
    log.step("read string key", { key: stringKey, bytes: got!.length });

    expect(await b.incr(counterKey)).toBe(1);
    expect(await b.incr(counterKey)).toBe(2);
    log.step("incremented counter", { key: counterKey, value: 2 });

    await b.hset(hashKey, "field", "value");
    const hval = await b.hget(hashKey, "field");
    expect(hval).not.toBeNull();
    expect(hval!.toString("utf8")).toBe("value");
    log.step("read hash field", { key: hashKey, field: "field" });

    const removed = await b.delete(stringKey, counterKey, hashKey);
    expect(removed).toBe(3);
    log.step("deleted lifecycle keys", { prefix, removed });

    expect(await b.ping()).toBe(true);
    log.step("ping passed", { prefix });
  });
});

/**
 * Redis behaviors that ioredis-mock cannot faithfully emulate, exercised against
 * the real server: multi-page SCAN, GETDEL (Redis >= 6.2), and EXPIRE NX/XX
 * semantics. Each block seeds its own uniquely-prefixed keys and removes them in
 * afterAll; cleanup is wrapped so it never masks a failure.
 */
describe.skipIf(!REDIS_PRESENT)("Redis cache live — real-server behaviors", () => {
  const log = liveLog("redis");
  const prefix = uniqueName("cache-rt");
  // Seed comfortably more keys than the SCAN COUNT so the cursor must page.
  const SCAN_COUNT = 10;
  const SEED_KEYS = 35;
  const scanPrefix = `${prefix}:scan`;
  const seededKeys = Array.from({ length: SEED_KEYS }, (_, i) => `${scanPrefix}:${i}`);
  const getdelKey = `${prefix}:getdel`;
  const expireKey = `${prefix}:expire`;
  const decodeKey = `${prefix}:decode`;
  let backend: Awaited<ReturnType<typeof getCache>> | undefined;
  // Separate backend with decodeResponses:true to assert string (not Buffer) reads.
  let decodeBackend: Awaited<ReturnType<typeof getCache>> | undefined;

  beforeAll(async () => {
    log.step("initializing backends", { provider: "redis", prefix });
    backend = await getCache("redis", "from_url", {
      url: env("CLOUDRIFT_LIVE_REDIS_URL")!,
    });
    decodeBackend = await getCache("redis", "from_url", {
      url: env("CLOUDRIFT_LIVE_REDIS_URL")!,
      decodeResponses: true,
    });
  });

  afterAll(async () => {
    try {
      const deleted = await backend?.delete(...seededKeys, getdelKey, expireKey, decodeKey);
      log.step("deleted keys", { prefix, deleted });
    } catch (err) {
      log.warn("cleanup failed", err, { prefix });
    }
    try {
      await backend?.close();
    } catch (err) {
      log.warn("backend close failed", err, { prefix });
    }
    try {
      await decodeBackend?.close();
    } catch (err) {
      log.warn("decode backend close failed", err, { prefix });
    }
  });

  it("scan() pages the cursor and finds all seeded keys", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    for (const key of seededKeys) {
      await b.set(key, "seed");
    }
    log.step("seeded scan keys", { count: seededKeys.length, scanCount: SCAN_COUNT });

    const found = new Set<string>();
    let cursor = 0;
    let pages = 0;
    do {
      const [next, keys] = await b.scan(cursor, `${scanPrefix}:*`, SCAN_COUNT);
      for (const k of keys) {
        found.add(typeof k === "string" ? k : k.toString("utf8"));
      }
      cursor = next;
      pages += 1;
      // Guard against an accidental infinite loop if the server misbehaves.
      expect(pages).toBeLessThanOrEqual(SEED_KEYS + 5);
    } while (cursor !== 0);

    log.step("scan complete", { pages, found: found.size });
    // Real SCAN returns keys across multiple cursor pages; assert all are found.
    expect(pages).toBeGreaterThan(1);
    for (const key of seededKeys) {
      expect(found.has(key)).toBe(true);
    }
  });

  it("getdel() returns the value and deletes the key (Redis >= 6.2)", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    await b.set(getdelKey, "getdel-value");
    const got = await b.getdel(getdelKey);
    expect(got).not.toBeNull();
    expect(got!.toString("utf8")).toBe("getdel-value");
    // The key must be gone after GETDEL.
    expect(await b.exists(getdelKey)).toBe(false);
    expect(await b.get(getdelKey)).toBeNull();
    // A second GETDEL on a missing key returns null.
    expect(await b.getdel(getdelKey)).toBeNull();
    log.step("getdel verified", { key: getdelKey });
  });

  it("expire() honors NX then XX semantics on a real key", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    // Persistent key (no TTL): XX must refuse, NX must apply.
    await b.set(expireKey, "expire-value");
    expect(await b.ttl(expireKey)).toBe(-1);

    // XX requires an existing TTL — none yet, so it must not set one.
    expect(await b.expire(expireKey, 100, { xx: true })).toBe(false);
    expect(await b.ttl(expireKey)).toBe(-1);

    // NX sets a TTL only when none exists — it should apply here.
    expect(await b.expire(expireKey, 100, { nx: true })).toBe(true);
    const ttlAfterNx = await b.ttl(expireKey);
    expect(ttlAfterNx).toBeGreaterThan(0);
    expect(ttlAfterNx).toBeLessThanOrEqual(100);

    // NX again must refuse because a TTL now exists.
    expect(await b.expire(expireKey, 500, { nx: true })).toBe(false);
    expect(await b.ttl(expireKey)).toBeLessThanOrEqual(100);

    // XX now applies because a TTL exists — overwrite it to a larger value.
    expect(await b.expire(expireKey, 300, { xx: true })).toBe(true);
    const ttlAfterXx = await b.ttl(expireKey);
    expect(ttlAfterXx).toBeGreaterThan(100);
    expect(ttlAfterXx).toBeLessThanOrEqual(300);
    log.step("expire NX/XX verified", { key: expireKey, ttl: ttlAfterXx });
  });

  it("decodeResponses:true returns strings, default returns Buffers", async () => {
    expect(backend).toBeDefined();
    expect(decodeBackend).toBeDefined();
    const b = backend!;
    const d = decodeBackend!;

    await b.set(decodeKey, "decode-value");

    // Default backend returns raw bytes (Buffer).
    const rawGot = await b.get(decodeKey);
    expect(Buffer.isBuffer(rawGot)).toBe(true);
    expect((rawGot as Buffer).toString("utf8")).toBe("decode-value");

    // decodeResponses backend returns a UTF-8 string, not a Buffer.
    const strGot = await d.get(decodeKey);
    expect(typeof strGot).toBe("string");
    expect(Buffer.isBuffer(strGot)).toBe(false);
    expect(strGot).toBe("decode-value");
    log.step("decodeResponses verified", { key: decodeKey });
  });
});
