import { afterEach, describe, expect, it, vi } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";

import { BaseRedisBackend } from "../src/cache/redisBase.js";
import type { RedisClientLike } from "../src/cache/redisBase.js";
import { getCache, cacheBrokerUrl } from "../src/cache/index.js";
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

  it("expire with nx flag forwards NX and sets ttl", async () => {
    cache = makeCache();
    await cache.set("ex_nx", "v");
    expect(await cache.expire("ex_nx", 90, { nx: true })).toBe(true);
    const remaining = await cache.ttl("ex_nx");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(90);
  });

  it("expire with xx flag forwards XX", async () => {
    cache = makeCache();
    await cache.set("ex_xx", "v");
    // ioredis-mock does not enforce XX semantics; assert it returns a boolean.
    expect(typeof (await cache.expire("ex_xx", 30, { xx: true }))).toBe("boolean");
  });

  it("expire with both nx and xx throws CloudRiftError before any client call", async () => {
    const expireSpy = vi.fn();
    const client = { expire: expireSpy } as unknown as RedisClientLike;
    const c = InjectableRedisBackend.withClient(client);
    await expect(c.expire("k", 10, { nx: true, xx: true })).rejects.toThrow(CloudRiftError);
    await expect(c.expire("k", 10, { nx: true, xx: true })).rejects.toThrow(/mutually exclusive/);
    expect(expireSpy).not.toHaveBeenCalled();
  });

  it("expire forwards the NX/XX flag argument to the client", async () => {
    const expireSpy = vi.fn().mockResolvedValue(1);
    const client = { expire: expireSpy } as unknown as RedisClientLike;
    const c = InjectableRedisBackend.withClient(client);
    await c.expire("k", 10, { nx: true });
    expect(expireSpy).toHaveBeenLastCalledWith("k", 10, "NX");
    await c.expire("k", 10, { xx: true });
    expect(expireSpy).toHaveBeenLastCalledWith("k", 10, "XX");
    await c.expire("k", 10);
    expect(expireSpy).toHaveBeenLastCalledWith("k", 10);
    expect(expireSpy.mock.calls[2]).toHaveLength(2);
  });

  it("expire returns false when the client reports the timeout was not set", async () => {
    const client = { expire: vi.fn().mockResolvedValue(0) } as unknown as RedisClientLike;
    const c = InjectableRedisBackend.withClient(client);
    expect(await c.expire("k", 10)).toBe(false);
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

  it("sadd returns newly-added count and is idempotent", async () => {
    cache = makeCache();
    expect(await cache.sadd("myset", "a", "b", "c")).toBe(3);
    // Re-adding existing members adds none.
    expect(await cache.sadd("myset", "a", "b")).toBe(0);
    expect(await cache.sadd("myset", "c", "d")).toBe(1);
  });

  it("scard counts set members", async () => {
    cache = makeCache();
    await cache.sadd("s", "a", "b", "c");
    expect(await cache.scard("s")).toBe(3);
    expect(await cache.scard("missing_set")).toBe(0);
  });

  it("srem removes members and returns the removed count", async () => {
    cache = makeCache();
    await cache.sadd("s", "a", "b", "c");
    expect(await cache.srem("s", "a", "missing")).toBe(1);
    expect(await cache.scard("s")).toBe(2);
  });

  it("sismember reflects membership", async () => {
    cache = makeCache();
    await cache.sadd("s", "a");
    expect(await cache.sismember("s", "a")).toBe(true);
    expect(await cache.sismember("s", "z")).toBe(false);
  });

  it("smembers returns all members as Buffers", async () => {
    cache = makeCache();
    await cache.sadd("s", "a", "b");
    const members = (await cache.smembers("s")) as Buffer[];
    members.forEach((m) => expect(Buffer.isBuffer(m)).toBe(true));
    expect(new Set(members.map((m) => m.toString()))).toEqual(new Set(["a", "b"]));
  });

  it("sinter with a single key is equivalent to smembers", async () => {
    cache = makeCache();
    await cache.sadd("s1", "a", "b", "c");
    const result = (await cache.sinter("s1")) as Buffer[];
    expect(new Set(result.map((m) => m.toString()))).toEqual(new Set(["a", "b", "c"]));
  });

  it("sinter returns the intersection of multiple sets", async () => {
    cache = makeCache();
    await cache.sadd("s1", "a", "b", "c");
    await cache.sadd("s2", "b", "c", "d");
    const result = (await cache.sinter("s1", "s2")) as Buffer[];
    expect(new Set(result.map((m) => m.toString()))).toEqual(new Set(["b", "c"]));
  });

  it("sinter with a missing key yields an empty result", async () => {
    cache = makeCache();
    await cache.sadd("s1", "a", "b");
    expect(await cache.sinter("s1", "missing")).toEqual([]);
  });

  it("sinter with zero keys throws CloudRiftError", async () => {
    cache = makeCache();
    await expect(cache.sinter()).rejects.toThrow(CloudRiftError);
    await expect(cache.sinter()).rejects.toThrow(/at least one key/);
  });

  it("scan returns [nextCursor, keys] with numeric cursor and Buffer keys", async () => {
    cache = makeCache();
    await cache.set("sc:1", "x");
    await cache.set("sc:2", "y");
    const [cursor, found] = await cache.scan(0);
    expect(typeof cursor).toBe("number");
    (found as Buffer[]).forEach((k) => expect(Buffer.isBuffer(k)).toBe(true));
    const names = (found as Buffer[]).map((k) => k.toString());
    expect(names).toContain("sc:1");
    expect(names).toContain("sc:2");
  });

  it("scan honors a MATCH pattern", async () => {
    cache = makeCache();
    await cache.set("a:1", "x");
    await cache.set("a:2", "y");
    await cache.set("b:1", "z");
    const [, found] = await cache.scan(0, "a:*");
    const names = (found as Buffer[]).map((k) => k.toString()).sort();
    expect(names).toEqual(["a:1", "a:2"]);
  });

  it("scan forwards MATCH and COUNT positional args to scanBuffer", async () => {
    const scanSpy = vi.fn().mockResolvedValue(["0", []]);
    const client = { scanBuffer: scanSpy } as unknown as RedisClientLike;
    const c = InjectableRedisBackend.withClient(client);
    await c.scan(5, "p:*", 100);
    expect(scanSpy).toHaveBeenCalledWith(5, "MATCH", "p:*", "COUNT", 100);
    await c.scan(0);
    expect(scanSpy).toHaveBeenLastCalledWith(0);
  });

  it("getdel returns the value and deletes the key", async () => {
    cache = makeCache();
    await cache.set("gd", "val");
    const v = await cache.getdel("gd");
    expect(v).toEqual(Buffer.from("val"));
    expect(await cache.get("gd")).toBeNull();
  });

  it("getdel returns null for a missing key", async () => {
    cache = makeCache();
    expect(await cache.getdel("nope")).toBeNull();
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

  it("pipeline sadd/expire run as queued commands", async () => {
    cache = makeCache();
    await cache.pipeline().sadd("pk", "a", "b").expire("pk", 60).exec();
    expect(await cache.scard("pk")).toBe(2);
    const t = await cache.ttl("pk");
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(60);
  });

  it("pipeline srem removes a queued member", async () => {
    cache = makeCache();
    await cache.sadd("pk2", "a", "b", "c");
    await cache.pipeline().srem("pk2", "a").exec();
    expect(await cache.scard("pk2")).toBe(2);
  });

  it("pipeline expire forwards NX/XX flag and omits it when unset", async () => {
    const expireSpy = vi.fn().mockReturnThis();
    const multi = {
      set: vi.fn().mockReturnThis(),
      getBuffer: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      incr: vi.fn().mockReturnThis(),
      expire: expireSpy,
      sadd: vi.fn().mockReturnThis(),
      srem: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    const client = { multi: () => multi } as unknown as RedisClientLike;
    const c = InjectableRedisBackend.withClient(client);
    await c.pipeline().expire("a", 30, { nx: true }).expire("b", 40).exec();
    expect(expireSpy).toHaveBeenNthCalledWith(1, "a", 30, "NX");
    expect(expireSpy).toHaveBeenNthCalledWith(2, "b", 40);
    expect(expireSpy.mock.calls[1]).toHaveLength(2);
  });
});

describe("decodeResponses flag", () => {
  // Subclass that injects a client and forces decodeResponses on, so we can
  // verify reads decode to strings (mirrors redis-py decode_responses).
  class DecodingBackend extends BaseRedisBackend {
    static withClient(client: RedisClientLike): DecodingBackend {
      return new DecodingBackend(client, true);
    }
  }

  it("get/hget/getdel return strings when decodeResponses is true", async () => {
    const client = {
      getBuffer: vi.fn().mockResolvedValue(Buffer.from("v")),
      hgetBuffer: vi.fn().mockResolvedValue(Buffer.from("hv")),
      getdelBuffer: vi.fn().mockResolvedValue(Buffer.from("gd")),
    } as unknown as RedisClientLike;
    const c = DecodingBackend.withClient(client);
    expect(await c.get("k")).toBe("v");
    expect(await c.hget("h", "f")).toBe("hv");
    expect(await c.getdel("g")).toBe("gd");
  });

  it("array reads decode to strings when decodeResponses is true", async () => {
    const client = {
      smembersBuffer: vi.fn().mockResolvedValue([Buffer.from("a"), Buffer.from("b")]),
      sinterBuffer: vi.fn().mockResolvedValue([Buffer.from("c")]),
      lrangeBuffer: vi.fn().mockResolvedValue([Buffer.from("x")]),
      mgetBuffer: vi.fn().mockResolvedValue([Buffer.from("m"), null]),
      hgetallBuffer: vi.fn().mockResolvedValue({ f: Buffer.from("hv") }),
      scanBuffer: vi.fn().mockResolvedValue(["0", [Buffer.from("k1")]]),
    } as unknown as RedisClientLike;
    const c = DecodingBackend.withClient(client);
    expect(await c.smembers("s")).toEqual(["a", "b"]);
    expect(await c.sinter("s")).toEqual(["c"]);
    expect(await c.lrange("l", 0, -1)).toEqual(["x"]);
    expect(await c.mget("m", "x")).toEqual(["m", null]);
    expect(await c.hgetall("h")).toEqual({ f: "hv" });
    expect(await c.scan(0)).toEqual([0, ["k1"]]);
  });

  it("returns Buffers by default (decodeResponses false)", async () => {
    const cache = makeCache();
    await cache.set("d", "v");
    expect(await cache.get("d")).toEqual(Buffer.from("v"));
    await cache.flush();
    await cache.close();
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

describe("cacheBrokerUrl", () => {
  it("builds a redis:// URL for self-hosted redis without a password", () => {
    expect(cacheBrokerUrl({ provider: "redis", host: "localhost", port: 6379 })).toBe(
      "redis://localhost:6379/0",
    );
  });

  it("includes default username and percent-encodes the password", () => {
    expect(
      cacheBrokerUrl({ provider: "redis", host: "h", port: 6379, password: "p@ss:/?#%", db: 2 }),
    ).toBe(`redis://default:${encodeURIComponent("p@ss:/?#%")}@h:6379/2`);
  });

  it("percent-encodes sub-delimiters !*'() that encodeURIComponent leaves raw", () => {
    // Python's quote(password, safe='') encodes these five characters, but
    // encodeURIComponent leaves them untouched. The produced URL must match
    // Python byte-for-byte.
    expect(cacheBrokerUrl({ provider: "redis", host: "h", port: 6379, password: "!*'()" })).toBe(
      "redis://default:%21%2A%27%28%29@h:6379/0",
    );
  });

  it("builds a rediss:// URL with ssl_cert_reqs for elasticache (default CERT_NONE)", () => {
    expect(cacheBrokerUrl({ provider: "elasticache", host: "ec", port: 6380 })).toBe(
      "rediss://ec:6380/0?ssl_cert_reqs=CERT_NONE",
    );
  });

  it("builds a rediss:// URL for azure_redis with explicit cert mode and auth", () => {
    expect(
      cacheBrokerUrl({
        provider: "azure_redis",
        host: "az",
        port: 10000,
        password: "key",
        sslCertReqs: "CERT_REQUIRED",
      }),
    ).toBe("rediss://default:key@az:10000/0?ssl_cert_reqs=CERT_REQUIRED");
  });

  it("rejects an invalid ssl_cert_reqs with CloudRiftError", () => {
    expect(() =>
      cacheBrokerUrl({ provider: "elasticache", host: "h", port: 6380, sslCertReqs: "CERT_BOGUS" }),
    ).toThrow(CloudRiftError);
    expect(() =>
      cacheBrokerUrl({ provider: "elasticache", host: "h", port: 6380, sslCertReqs: "CERT_BOGUS" }),
    ).toThrow(/Invalid sslCertReqs/);
  });

  it("rejects a negative or non-integer db with CloudRiftError", () => {
    expect(() => cacheBrokerUrl({ provider: "redis", host: "h", port: 6379, db: -1 })).toThrow(
      /Invalid db/,
    );
    expect(() => cacheBrokerUrl({ provider: "redis", host: "h", port: 6379, db: 1.5 })).toThrow(
      CloudRiftError,
    );
  });

  it("rejects an unsupported provider with CloudRiftError", () => {
    expect(() => cacheBrokerUrl({ provider: "memcached", host: "h", port: 11211 })).toThrow(
      /Unsupported cache provider/,
    );
  });
});
