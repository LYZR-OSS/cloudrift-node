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
