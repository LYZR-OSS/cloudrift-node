import { afterEach, describe, expect, it, vi } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";

import { BaseRedisBackend } from "../src/cache/redisBase.js";
import type { RedisClientLike } from "../src/cache/redisBase.js";
import { getCache } from "../src/cache/index.js";
import { StandaloneRedisBackend } from "../src/cache/redisStandalone.js";
import { generateElastiCacheIamToken } from "../src/cache/redisElasticache.js";
import { CloudRiftError } from "../src/core/errors.js";

/** Concrete subclass exposing the protected constructor for test injection. */
class TestRedisBackend extends BaseRedisBackend {
  static withMock(): TestRedisBackend {
    // ioredis-mock is a drop-in for the ioredis client surface.
    return new TestRedisBackend(new RedisMock() as unknown as Redis);
  }
}

function makeCache(): TestRedisBackend {
  return TestRedisBackend.withMock();
}

/**
 * Subclass that accepts an arbitrary injected client, so a test can supply a
 * stub whose responses (e.g. `ping` reply) differ from the ioredis-mock
 * defaults. Used to exercise BaseRedisBackend branches the mock can't reach.
 */
class InjectableRedisBackend extends BaseRedisBackend {
  static withClient(client: RedisClientLike): InjectableRedisBackend {
    return new InjectableRedisBackend(client);
  }
  get rawClient(): RedisClientLike {
    return this.client;
  }
}

describe("BaseRedisBackend ops", () => {
  let cache: TestRedisBackend;

  afterEach(async () => {
    if (cache) {
      await cache.flush();
      await cache.close();
    }
  });

  it("set/get round-trips bytes as Buffer", async () => {
    cache = makeCache();
    await cache.set("k1", Buffer.from("hello"));
    const v = await cache.get("k1");
    expect(Buffer.isBuffer(v)).toBe(true);
    expect(v?.toString()).toBe("hello");
    expect(v).toEqual(Buffer.from("hello"));
  });

  it("set/get round-trips string input as Buffer", async () => {
    cache = makeCache();
    await cache.set("k_str", "world");
    const v = await cache.get("k_str");
    expect(v).toEqual(Buffer.from("world"));
  });

  it("get missing returns null", async () => {
    cache = makeCache();
    expect(await cache.get("nope")).toBeNull();
  });

  it("set with ttl stores value", async () => {
    cache = makeCache();
    await cache.set("k_ttl", "v", 60);
    expect(await cache.get("k_ttl")).toEqual(Buffer.from("v"));
    const remaining = await cache.ttl("k_ttl");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(60);
  });

  it("delete returns removed count", async () => {
    cache = makeCache();
    await cache.set("del_me", "x");
    expect(await cache.delete("del_me")).toBe(1);
    expect(await cache.get("del_me")).toBeNull();
  });

  it("delete multiple counts only existing", async () => {
    cache = makeCache();
    await cache.set("a", "1");
    await cache.set("b", "2");
    expect(await cache.delete("a", "b", "missing")).toBe(2);
  });

  it("delete with no keys returns 0", async () => {
    cache = makeCache();
    expect(await cache.delete()).toBe(0);
  });

  it("exists", async () => {
    cache = makeCache();
    expect(await cache.exists("ghost")).toBe(false);
    await cache.set("ghost", "boo");
    expect(await cache.exists("ghost")).toBe(true);
  });

  it("expire and ttl", async () => {
    cache = makeCache();
    await cache.set("ex_key", "v");
    expect(await cache.expire("ex_key", 120)).toBe(true);
    const remaining = await cache.ttl("ex_key");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(120);
  });

  it("ttl -1 when no expiry", async () => {
    cache = makeCache();
    await cache.set("no_exp", "v");
    expect(await cache.ttl("no_exp")).toBe(-1);
  });

  it("ttl -2 when key missing", async () => {
    cache = makeCache();
    expect(await cache.ttl("absent")).toBe(-2);
  });

  it("keys pattern", async () => {
    cache = makeCache();
    await cache.set("foo:1", "a");
    await cache.set("foo:2", "b");
    await cache.set("bar:1", "c");
    const found = await cache.keys("foo:*");
    expect(new Set(found)).toEqual(new Set(["foo:1", "foo:2"]));
    found.forEach((k) => expect(typeof k).toBe("string"));
  });

  it("hset/hget", async () => {
    cache = makeCache();
    expect(await cache.hset("myhash", "field1", "val1")).toBe(1);
    expect(await cache.hget("myhash", "field1")).toEqual(Buffer.from("val1"));
  });

  it("hget missing field returns null", async () => {
    cache = makeCache();
    await cache.hset("h", "f", "v");
    expect(await cache.hget("h", "missing")).toBeNull();
  });

  it("hgetall returns Buffer values", async () => {
    cache = makeCache();
    await cache.hset("h2", "a", "1");
    await cache.hset("h2", "b", "2");
    const all = await cache.hgetall("h2");
    expect(all.a).toEqual(Buffer.from("1"));
    expect(all.b).toEqual(Buffer.from("2"));
  });

  it("hdel counts removed", async () => {
    cache = makeCache();
    await cache.hset("h3", "x", "1");
    await cache.hset("h3", "y", "2");
    expect(await cache.hdel("h3", "x", "missing")).toBe(1);
    expect(await cache.hget("h3", "x")).toBeNull();
  });

  it("lpush/lrange/llen", async () => {
    cache = makeCache();
    await cache.lpush("mylist", "c", "b", "a");
    expect(await cache.llen("mylist")).toBe(3);
    expect(await cache.lrange("mylist", 0, -1)).toEqual([
      Buffer.from("a"),
      Buffer.from("b"),
      Buffer.from("c"),
    ]);
  });

  it("rpush", async () => {
    cache = makeCache();
    await cache.rpush("rlist", "1", "2", "3");
    expect(await cache.lrange("rlist", 0, -1)).toEqual([
      Buffer.from("1"),
      Buffer.from("2"),
      Buffer.from("3"),
    ]);
  });

  it("incr", async () => {
    cache = makeCache();
    await cache.set("counter", "10");
    expect(await cache.incr("counter")).toBe(11);
  });

  it("decr", async () => {
    cache = makeCache();
    await cache.set("counter2", "5");
    expect(await cache.decr("counter2")).toBe(4);
  });

  it("mset/mget", async () => {
    cache = makeCache();
    await cache.mset({ mk1: "v1", mk2: "v2" });
    const results = await cache.mget("mk1", "mk2", "mk3");
    expect(results[0]).toEqual(Buffer.from("v1"));
    expect(results[1]).toEqual(Buffer.from("v2"));
    expect(results[2]).toBeNull();
  });

  it("setex default delegates to set with ttl", async () => {
    cache = makeCache();
    await cache.setex("sk", "hello", 60);
    expect(await cache.get("sk")).toEqual(Buffer.from("hello"));
    const remaining = await cache.ttl("sk");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(60);
  });

  it("ping", async () => {
    cache = makeCache();
    expect(await cache.ping()).toBe(true);
  });

  it("healthCheck default uses ping", async () => {
    cache = makeCache();
    expect(await cache.healthCheck()).toBe(true);
  });

  it("flush clears keys", async () => {
    cache = makeCache();
    await cache.set("f1", "a");
    await cache.set("f2", "b");
    await cache.flush();
    expect(await cache.get("f1")).toBeNull();
    expect(await cache.get("f2")).toBeNull();
  });

  it("pipeline exec runs queued commands atomically", async () => {
    cache = makeCache();
    const results = await cache.pipeline().set("p1", "1").incr("p1").get("p1").exec();
    // ioredis exec returns [error, value] tuples per command.
    expect(results.length).toBe(3);
    const last = results[2] as [unknown, Buffer];
    expect(last[0]).toBeNull();
    expect(last[1]).toEqual(Buffer.from("2"));
  });

  it("pipeline set with ttl and delete", async () => {
    cache = makeCache();
    await cache.pipeline().set("pt", "x", 50).exec();
    expect(await cache.get("pt")).toEqual(Buffer.from("x"));
    const t = await cache.ttl("pt");
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(50);
    await cache.pipeline().delete("pt").exec();
    expect(await cache.get("pt")).toBeNull();
  });
});

describe("BaseRedisBackend branch coverage", () => {
  // redisBase.ts:297 `return reply === "PONG"` — the false branch.
  it("ping returns false when the server reply is not PONG", async () => {
    const client = {
      ping: vi.fn().mockResolvedValue("NOPE"),
    } as unknown as RedisClientLike;
    const cache = InjectableRedisBackend.withClient(client);
    expect(await cache.ping()).toBe(false);
    expect(client.ping).toHaveBeenCalledTimes(1);
  });

  it("ping returns true when the server reply is PONG", async () => {
    const client = {
      ping: vi.fn().mockResolvedValue("PONG"),
    } as unknown as RedisClientLike;
    const cache = InjectableRedisBackend.withClient(client);
    expect(await cache.ping()).toBe(true);
  });

  // redisBase.ts:142 `if (ttl !== undefined && ttl !== null)` — distinguish the
  // with-ttl path (EX arg passed) from the without-ttl path (no expiry arg).
  it("set WITH ttl passes the EX expiry argument to the client", async () => {
    const setSpy = vi.fn().mockResolvedValue("OK");
    const client = { set: setSpy } as unknown as RedisClientLike;
    const cache = InjectableRedisBackend.withClient(client);
    await cache.set("k", "v", 60);
    expect(setSpy).toHaveBeenCalledWith("k", "v", "EX", 60);
  });

  it("set WITHOUT ttl omits the EX expiry argument", async () => {
    const setSpy = vi.fn().mockResolvedValue("OK");
    const client = { set: setSpy } as unknown as RedisClientLike;
    const cache = InjectableRedisBackend.withClient(client);
    await cache.set("k", "v");
    expect(setSpy).toHaveBeenCalledWith("k", "v");
    expect(setSpy.mock.calls[0]).toHaveLength(2);
  });

  // Observable end-to-end distinction over ioredis-mock: with ttl -> positive
  // remaining; without ttl -> -1 (no expiry).
  it("set with ttl yields a positive ttl, without ttl yields -1", async () => {
    const cache = makeCache();
    await cache.set("with_ttl", "v", 45);
    const withTtl = await cache.ttl("with_ttl");
    expect(withTtl).toBeGreaterThan(0);
    expect(withTtl).toBeLessThanOrEqual(45);
    await cache.set("no_ttl", "v");
    expect(await cache.ttl("no_ttl")).toBe(-1);
    await cache.flush();
    await cache.close();
  });

  // redisBase.ts pipeline:87 `if (ttl !== undefined && ttl !== null)`.
  it("pipeline set WITH ttl passes EX, WITHOUT ttl omits it", async () => {
    const setSpy = vi.fn().mockReturnThis();
    const multi = {
      set: setSpy,
      getBuffer: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      incr: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    const client = { multi: () => multi } as unknown as RedisClientLike;
    const cache = InjectableRedisBackend.withClient(client);
    await cache.pipeline().set("a", "1", 30).set("b", "2").exec();
    expect(setSpy).toHaveBeenNthCalledWith(1, "a", "1", "EX", 30);
    expect(setSpy).toHaveBeenNthCalledWith(2, "b", "2");
    expect(setSpy.mock.calls[1]).toHaveLength(2);
  });

  // redisBase.ts:221 `if (fields.length === 0)` — hdel early-return guard.
  it("hdel with no fields returns 0 without calling the client", async () => {
    const hdelSpy = vi.fn();
    const client = { hdel: hdelSpy } as unknown as RedisClientLike;
    const cache = InjectableRedisBackend.withClient(client);
    expect(await cache.hdel("h")).toBe(0);
    expect(hdelSpy).not.toHaveBeenCalled();
  });

  // redisBase.ts:154 `if (keys.length === 0)` — delete early-return guard.
  it("delete with no keys returns 0 without calling the client", async () => {
    const delSpy = vi.fn();
    const client = { del: delSpy } as unknown as RedisClientLike;
    const cache = InjectableRedisBackend.withClient(client);
    expect(await cache.delete()).toBe(0);
    expect(delSpy).not.toHaveBeenCalled();
  });
});

describe("getCache factory dispatch", () => {
  it("normalizes provider and auth method values from config", async () => {
    const cache = await getCache(" REDIS ", " FROM_URL ", { url: "redis://localhost:6379" });
    expect(cache).toBeInstanceOf(StandaloneRedisBackend);
    await cache.close();
  });

  it("rejects blank provider values from config", async () => {
    await expect(getCache(" ", "from_url", { url: "redis://localhost" })).rejects.toThrow(
      /Unknown cache provider/,
    );
  });

  it("throws CloudRiftError on unknown provider", async () => {
    await expect(
      getCache("gcp_memorystore", "from_url", { url: "redis://localhost" }),
    ).rejects.toThrow(CloudRiftError);
    await expect(
      getCache("gcp_memorystore", "from_url", { url: "redis://localhost" }),
    ).rejects.toThrow(/Unknown cache provider/);
  });

  it("throws CloudRiftError on unknown auth method for a valid provider", async () => {
    await expect(getCache("redis", "from_nonsense", {})).rejects.toThrow(CloudRiftError);
    await expect(getCache("redis", "from_nonsense", {})).rejects.toThrow(/no auth method/);
  });

  it("maps snake_case method to the matching provider constructor", async () => {
    // from_iam_auth exists only on elasticache; from_url only on redis.
    await expect(getCache("redis", "from_iam_auth", {})).rejects.toThrow(/no auth method/);
    await expect(getCache("elasticache", "from_url", {})).rejects.toThrow(/no auth method/);
    await expect(getCache("azure_redis", "from_url", {})).rejects.toThrow(/no auth method/);
  });
});

describe("generateElastiCacheIamToken", () => {
  const creds = {
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secretexamplekey",
  };

  it("produces a presigned-URL token of the expected shape", async () => {
    const token = await generateElastiCacheIamToken({
      host: "my-cluster.abc123.use1.cache.amazonaws.com",
      port: 6379,
      username: "iam-user",
      region: "us-east-1",
      credentials: creds,
    });

    // No scheme prefix; starts with host:port/?
    expect(token.startsWith("https://")).toBe(false);
    expect(token).toContain("my-cluster.abc123.use1.cache.amazonaws.com:6379/?");
    // Carries the connect action and the username.
    expect(token).toContain("Action=connect");
    expect(token).toContain("User=iam-user");
    // SigV4 query params.
    expect(token).toContain("X-Amz-Signature=");
    expect(token).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(token).toContain("X-Amz-Credential=");
    expect(token).toContain("X-Amz-Date=");
    expect(token).toContain("X-Amz-Expires=900");
    expect(token).toContain("X-Amz-SignedHeaders=");
  });

  it("includes the session token when provided", async () => {
    const token = await generateElastiCacheIamToken({
      host: "h.cache.amazonaws.com",
      port: 6379,
      username: "u",
      region: "eu-west-1",
      credentials: { ...creds, sessionToken: "sess-token-123" },
    });
    expect(token).toContain("X-Amz-Security-Token=");
  });
});
