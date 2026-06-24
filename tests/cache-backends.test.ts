/**
 * Backend factory wiring tests.
 *
 * These tests assert the EXACT ioredis options object each factory builds
 * (host/port/db/password/username/tls), plus the Entra/IAM token-refresh hooks.
 * `ioredis-mock` ignores constructor options, so it cannot verify this wiring —
 * we install a capturing `vi.mock("ioredis", ...)` constructor instead. They
 * live in their own file so the capturing mock does not disturb the
 * ioredis-mock-based ops tests in cache.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Capturing ioredis mock -------------------------------------------------
// Records every constructed client so tests can inspect the options object and
// drive the stored event handlers (e.g. the "close" handler used for refresh).
interface CapturedClient {
  ctorArgs: unknown[];
  options: Record<string, unknown>;
  handlers: Record<string, Array<(...args: unknown[]) => void>>;
  on(event: string, cb: (...args: unknown[]) => void): CapturedClient;
  quit(): Promise<void>;
  disconnect(): void;
}

const constructed: CapturedClient[] = [];

vi.mock("ioredis", () => {
  class FakeRedis {
    ctorArgs: unknown[];
    options: Record<string, unknown>;
    handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

    constructor(...args: unknown[]) {
      this.ctorArgs = args;
      // ioredis exposes the resolved options object on the instance. When the
      // first arg is a URL string the options come second; otherwise first.
      const optsArg =
        typeof args[0] === "string"
          ? (args[1] as Record<string, unknown>)
          : (args[0] as Record<string, unknown>);
      this.options = { ...(optsArg ?? {}) };
      constructed.push(this as unknown as CapturedClient);
    }

    on(event: string, cb: (...args: unknown[]) => void): this {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }

    async quit(): Promise<void> {}
    disconnect(): void {}
  }
  return { default: FakeRedis };
});

// --- Capturing @azure/identity mock -----------------------------------------
// getToken returns a fresh token each call so refresh assertions can observe a
// change. The same backing counter drives both credential classes.
let azureTokenCounter = 0;
const lastClientId: { value?: string } = {};
const lastServicePrincipalArgs: { tenantId?: string; clientId?: string; clientSecret?: string } =
  {};

vi.mock("@azure/identity", () => {
  class ManagedIdentityCredential {
    constructor(clientId?: string) {
      lastClientId.value = clientId;
    }
    async getToken(_scope: string): Promise<{ token: string }> {
      azureTokenCounter += 1;
      return { token: `entra-token-${azureTokenCounter}` };
    }
  }
  class ClientSecretCredential {
    constructor(tenantId: string, clientId: string, clientSecret: string) {
      lastServicePrincipalArgs.tenantId = tenantId;
      lastServicePrincipalArgs.clientId = clientId;
      lastServicePrincipalArgs.clientSecret = clientSecret;
    }
    async getToken(_scope: string): Promise<{ token: string }> {
      azureTokenCounter += 1;
      return { token: `entra-token-${azureTokenCounter}` };
    }
  }
  return { ManagedIdentityCredential, ClientSecretCredential };
});

// --- Capturing node:fs mock -------------------------------------------------
// Predictable buffers per path so TLS material assertions are deterministic.
vi.mock("node:fs", () => ({
  readFileSync: (path: string) => Buffer.from(`FILE:${path}`),
}));

// --- Capturing @aws-sdk/credential-providers mock ---------------------------
// Records which provider factory resolveCredentials selected (named profile vs
// the default node provider chain) and the args passed, so the branch + the
// fromIni({ profile }) shape can be pinned. Each returns a thunk yielding a
// distinct credential set so the chosen branch is observable in the token.
const credProviderCalls: { fromIni: unknown[]; fromNodeProviderChain: unknown[] } = {
  fromIni: [],
  fromNodeProviderChain: [],
};

vi.mock("@aws-sdk/credential-providers", () => ({
  fromIni: (opts: { profile?: string }) => {
    credProviderCalls.fromIni.push(opts);
    // A reserved profile name lets a single test deterministically drive the
    // resolveCredentials failure path so the IAM catch-block message is covered.
    if (opts?.profile === "explode") {
      return async () => {
        throw new Error("boom-profile-load");
      };
    }
    return async () => ({ accessKeyId: "PROFILE_AKID", secretAccessKey: "profile-secret" });
  },
  fromNodeProviderChain: (...args: unknown[]) => {
    credProviderCalls.fromNodeProviderChain.push(args[0]);
    return async () => ({ accessKeyId: "CHAIN_AKID", secretAccessKey: "chain-secret" });
  },
}));

import { CacheConnectionError } from "../src/core/errors.js";
import { StandaloneRedisBackend } from "../src/cache/redisStandalone.js";
import {
  AWSElastiCacheBackend,
  generateElastiCacheIamToken,
} from "../src/cache/redisElasticache.js";
import { AzureRedisCacheBackend } from "../src/cache/redisAzure.js";

/** The most-recently constructed fake ioredis client. */
function lastClient(): CapturedClient {
  return constructed[constructed.length - 1];
}

/**
 * Invoke the stored "close" handlers and wait until the async token refresh
 * has written `client.options.password` (genToken is async — SigV4 presign for
 * IAM, getToken for Entra — so we poll until the password leaves `expected`).
 */
async function fireClose(client: CapturedClient, expected: unknown): Promise<void> {
  for (const cb of client.handlers.close ?? []) {
    cb();
  }
  for (let i = 0; i < 100 && client.options.password === expected; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  constructed.length = 0;
  azureTokenCounter = 0;
  credProviderCalls.fromIni.length = 0;
  credProviderCalls.fromNodeProviderChain.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("StandaloneRedisBackend factory wiring", () => {
  it("fromCredentials builds host/port/db with defaults and no tls when ssl falsy", async () => {
    await StandaloneRedisBackend.fromCredentials({ host: "h" });
    const opts = lastClient().options;
    expect(opts.host).toBe("h");
    expect(opts.port).toBe(6379);
    expect(opts.db).toBe(0);
    expect("tls" in opts).toBe(false);
    expect("password" in opts).toBe(false);
    expect("username" in opts).toBe(false);
  });

  it("fromCredentials applies explicit port/db/password/username", async () => {
    await StandaloneRedisBackend.fromCredentials({
      host: "h",
      port: 6390,
      db: 3,
      password: "pw",
      username: "user",
    });
    const opts = lastClient().options;
    expect(opts.port).toBe(6390);
    expect(opts.db).toBe(3);
    expect(opts.password).toBe("pw");
    expect(opts.username).toBe("user");
  });

  it("fromCredentials with ssl:true and no certs uses empty tls {}", async () => {
    await StandaloneRedisBackend.fromCredentials({ host: "h", ssl: true });
    const opts = lastClient().options;
    expect(opts.tls).toEqual({});
  });

  it("fromCredentials with ssl:true and sslCaCerts builds tls.ca", async () => {
    await StandaloneRedisBackend.fromCredentials({
      host: "h",
      ssl: true,
      sslCaCerts: "/ca.pem",
    });
    const tls = lastClient().options.tls as { ca?: Buffer; cert?: unknown; key?: unknown };
    expect(tls.ca).toEqual(Buffer.from("FILE:/ca.pem"));
    expect("cert" in tls).toBe(false);
    expect("key" in tls).toBe(false);
  });

  it("fromCredentials with ssl:false and sslCaCerts still has no tls", async () => {
    await StandaloneRedisBackend.fromCredentials({
      host: "h",
      ssl: false,
      sslCaCerts: "/ca.pem",
    });
    expect("tls" in lastClient().options).toBe(false);
  });

  it("fromTlsCert defaults port 6380 and builds tls with ca/cert/key", async () => {
    await StandaloneRedisBackend.fromTlsCert({
      host: "h",
      sslCertfile: "/client.crt",
      sslKeyfile: "/client.key",
      sslCaCerts: "/ca.pem",
      password: "pw",
      username: "user",
      db: 2,
    });
    const opts = lastClient().options;
    expect(opts.port).toBe(6380);
    expect(opts.db).toBe(2);
    expect(opts.password).toBe("pw");
    expect(opts.username).toBe("user");
    const tls = opts.tls as { ca?: Buffer; cert?: Buffer; key?: Buffer };
    expect(tls.ca).toEqual(Buffer.from("FILE:/ca.pem"));
    expect(tls.cert).toEqual(Buffer.from("FILE:/client.crt"));
    expect(tls.key).toEqual(Buffer.from("FILE:/client.key"));
  });

  it("fromTlsCert without password/username omits them", async () => {
    await StandaloneRedisBackend.fromTlsCert({
      host: "h",
      sslCertfile: "/client.crt",
      sslKeyfile: "/client.key",
    });
    const opts = lastClient().options;
    expect("password" in opts).toBe(false);
    expect("username" in opts).toBe(false);
    const tls = opts.tls as { cert?: Buffer; key?: Buffer; ca?: unknown };
    expect(tls.cert).toEqual(Buffer.from("FILE:/client.crt"));
    expect(tls.key).toEqual(Buffer.from("FILE:/client.key"));
    expect("ca" in tls).toBe(false);
  });

  it("fromUrl passes url as first ctor arg and builds tls only when sslCaCerts given", async () => {
    await StandaloneRedisBackend.fromUrl({
      url: "rediss://localhost:6380/0",
      sslCaCerts: "/ca.pem",
    });
    const client = lastClient();
    expect(client.ctorArgs[0]).toBe("rediss://localhost:6380/0");
    const tls = client.options.tls as { ca?: Buffer };
    expect(tls.ca).toEqual(Buffer.from("FILE:/ca.pem"));
  });

  it("fromUrl with no certs omits tls", async () => {
    await StandaloneRedisBackend.fromUrl({ url: "redis://localhost:6379/0" });
    expect("tls" in lastClient().options).toBe(false);
  });

  it("threads decodeResponses onto the backend (default false)", async () => {
    const def = await StandaloneRedisBackend.fromCredentials({ host: "h" });
    expect((def as unknown as { decodeResponses: boolean }).decodeResponses).toBe(false);
    const decoding = await StandaloneRedisBackend.fromCredentials({
      host: "h",
      decodeResponses: true,
    });
    expect((decoding as unknown as { decodeResponses: boolean }).decodeResponses).toBe(true);
  });
});

describe("AWSElastiCacheBackend factory wiring", () => {
  it("fromAuthToken defaults port 6379, sets password, tls {} when ssl default true", async () => {
    await AWSElastiCacheBackend.fromAuthToken({ host: "h", authToken: "tok" });
    const opts = lastClient().options;
    expect(opts.host).toBe("h");
    expect(opts.port).toBe(6379);
    expect(opts.db).toBe(0);
    expect(opts.password).toBe("tok");
    expect(opts.tls).toEqual({});
  });

  it("fromAuthToken with ssl:false omits tls", async () => {
    await AWSElastiCacheBackend.fromAuthToken({ host: "h", authToken: "tok", ssl: false });
    expect("tls" in lastClient().options).toBe(false);
  });

  it("fromAuthToken with sslCaCerts builds tls.ca", async () => {
    await AWSElastiCacheBackend.fromAuthToken({
      host: "h",
      authToken: "tok",
      sslCaCerts: "/ca.pem",
    });
    const tls = lastClient().options.tls as { ca?: Buffer };
    expect(tls.ca).toEqual(Buffer.from("FILE:/ca.pem"));
  });

  it("fromTlsCert defaults port 6380 and builds tls from cert/key/ca", async () => {
    await AWSElastiCacheBackend.fromTlsCert({
      host: "h",
      sslCertfile: "/client.crt",
      sslKeyfile: "/client.key",
      sslCaCerts: "/ca.pem",
      authToken: "tok",
    });
    const opts = lastClient().options;
    expect(opts.port).toBe(6380);
    expect(opts.password).toBe("tok");
    const tls = opts.tls as { ca?: Buffer; cert?: Buffer; key?: Buffer };
    expect(tls.ca).toEqual(Buffer.from("FILE:/ca.pem"));
    expect(tls.cert).toEqual(Buffer.from("FILE:/client.crt"));
    expect(tls.key).toEqual(Buffer.from("FILE:/client.key"));
  });

  it("fromIamAuth wires username + IAM-token password and refreshes on close", async () => {
    await AWSElastiCacheBackend.fromIamAuth({
      host: "my-cluster.abc.use1.cache.amazonaws.com",
      username: "iam-user",
      region: "us-east-1",
      awsAccessKeyId: "AKIAEXAMPLE",
      awsSecretAccessKey: "secretexamplekey",
    });
    const client = lastClient();
    const opts = client.options;
    expect(opts.port).toBe(6379);
    expect(opts.db).toBe(0);
    expect(opts.username).toBe("iam-user");
    expect(opts.tls).toEqual({});
    const firstPassword = opts.password as string;
    // Token is the bare presigned URL: host:port/?...Action=connect...
    expect(firstPassword).toContain("my-cluster.abc.use1.cache.amazonaws.com:6379/?");
    expect(firstPassword).toContain("Action=connect");
    expect(firstPassword).toContain("User=iam-user");

    // R2-1: the refresh handler must be registered on the "close" event
    // specifically — not "end"/"error" — so an event-name mutant is caught.
    expect(client.handlers.close).toHaveLength(1);
    expect(client.handlers.end).toBeUndefined();
    expect(client.handlers.error).toBeUndefined();

    // Drive the close handler: it must regenerate a token and write it back into
    // client.options.password. Overwrite with a sentinel first so we can prove
    // the assignment ran (the regenerated SigV4 token may be byte-identical to
    // the original when produced within the same clock-second).
    client.options.password = "STALE_SENTINEL";
    await fireClose(client, "STALE_SENTINEL");
    const refreshed = client.options.password as string;
    expect(typeof refreshed).toBe("string");
    expect(refreshed).not.toBe("STALE_SENTINEL");
    expect(refreshed).toContain("Action=connect");
    expect(refreshed).toContain("my-cluster.abc.use1.cache.amazonaws.com:6379/?");
  });

  it("fromIamAuth threads decodeResponses onto the backend", async () => {
    const backend = await AWSElastiCacheBackend.fromIamAuth({
      host: "h.cache.amazonaws.com",
      username: "u",
      region: "us-east-1",
      awsAccessKeyId: "AKIA",
      awsSecretAccessKey: "secret",
      decodeResponses: true,
    });
    expect((backend as unknown as { decodeResponses: boolean }).decodeResponses).toBe(true);
  });

  it("fromIamAuth honors explicit port and ssl:false (no tls)", async () => {
    await AWSElastiCacheBackend.fromIamAuth({
      host: "h.cache.amazonaws.com",
      username: "u",
      region: "eu-west-1",
      port: 7000,
      ssl: false,
      awsAccessKeyId: "AKIA",
      awsSecretAccessKey: "secret",
    });
    const opts = lastClient().options;
    expect(opts.port).toBe(7000);
    expect("tls" in opts).toBe(false);
    expect(opts.password as string).toContain("h.cache.amazonaws.com:7000/?");
  });
});

describe("generateElastiCacheIamToken request shape", () => {
  it("signs a 900s elasticache GET presign and returns the scheme-stripped host:port/?query", async () => {
    const token = await generateElastiCacheIamToken({
      host: "cluster.example.cache.amazonaws.com",
      port: 6379,
      username: "iam-user",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secretexamplekey" },
    });

    // Scheme stripped, exact host:port/? prefix (pins protocol "https:" removal,
    // path "/", and the `${host}:${port}/?` template).
    expect(token.startsWith("cluster.example.cache.amazonaws.com:6379/?")).toBe(true);
    expect(token).not.toContain("https://");

    // The action + ACL username query the request carries verbatim.
    expect(token).toContain("Action=connect");
    expect(token).toContain("User=iam-user");

    // Query params are joined with "&" (kills the join-separator mutant).
    const queryString = token.split("/?")[1];
    expect(queryString.split("&").length).toBeGreaterThan(1);

    // SigV4 presign metadata proves service="elasticache", expiresIn=900, and
    // that the GET request with the host header was signed (SignedHeaders=host).
    expect(token).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(token).toContain("X-Amz-Expires=900");
    expect(token).toContain(encodeURIComponent("/us-east-1/elasticache/aws4_request"));
    expect(token).toContain("X-Amz-SignedHeaders=host");
    expect(token).toContain("X-Amz-Signature=");
  });

  it("includes the explicit port in both the prefix and the signed host header", async () => {
    const token = await generateElastiCacheIamToken({
      host: "h.cache.amazonaws.com",
      port: 7000,
      username: "u",
      region: "eu-west-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    });
    expect(token.startsWith("h.cache.amazonaws.com:7000/?")).toBe(true);
    expect(token).toContain(encodeURIComponent("/eu-west-1/elasticache/aws4_request"));
  });
});

describe("AWSElastiCacheBackend.fromIamAuth credential resolution", () => {
  it("includes sessionToken in the signed credentials when supplied with explicit keys", async () => {
    // With a session token, the SigV4 presign emits X-Amz-Security-Token,
    // proving sessionToken was threaded into the credentials object (L151).
    await AWSElastiCacheBackend.fromIamAuth({
      host: "h.cache.amazonaws.com",
      username: "u",
      region: "us-east-1",
      awsAccessKeyId: "AKIA",
      awsSecretAccessKey: "secret",
      awsSessionToken: "FwoSESSIONTOKEN",
    });
    const password = lastClient().options.password as string;
    expect(password).toContain("X-Amz-Security-Token");
    expect(password).toContain(encodeURIComponent("FwoSESSIONTOKEN"));
    // No credential-provider chain consulted when explicit keys are present.
    expect(credProviderCalls.fromIni).toHaveLength(0);
    expect(credProviderCalls.fromNodeProviderChain).toHaveLength(0);
  });

  it("omits sessionToken (no security-token query) when none is supplied", async () => {
    await AWSElastiCacheBackend.fromIamAuth({
      host: "h.cache.amazonaws.com",
      username: "u",
      region: "us-east-1",
      awsAccessKeyId: "AKIA",
      awsSecretAccessKey: "secret",
    });
    const password = lastClient().options.password as string;
    expect(password).not.toContain("X-Amz-Security-Token");
  });

  it("uses fromIni with the named profile when profileName is set (no explicit keys)", async () => {
    await AWSElastiCacheBackend.fromIamAuth({
      host: "h.cache.amazonaws.com",
      username: "u",
      region: "us-east-1",
      profileName: "my-profile",
    });
    // fromIni selected, with exactly { profile: "my-profile" } — not the chain.
    expect(credProviderCalls.fromIni).toHaveLength(1);
    expect(credProviderCalls.fromIni[0]).toEqual({ profile: "my-profile" });
    expect(credProviderCalls.fromNodeProviderChain).toHaveLength(0);
  });

  it("falls back to the default node provider chain when neither keys nor profile given", async () => {
    await AWSElastiCacheBackend.fromIamAuth({
      host: "h.cache.amazonaws.com",
      username: "u",
      region: "us-east-1",
    });
    expect(credProviderCalls.fromNodeProviderChain).toHaveLength(1);
    expect(credProviderCalls.fromIni).toHaveLength(0);
  });

  it("requires BOTH access key and secret to skip the provider chain", async () => {
    // Only the access key id -> the explicit-keys branch is false, so the
    // default chain is consulted (kills the && -> || logical-operator mutant).
    await AWSElastiCacheBackend.fromIamAuth({
      host: "h.cache.amazonaws.com",
      username: "u",
      region: "us-east-1",
      awsAccessKeyId: "AKIA",
    });
    expect(credProviderCalls.fromNodeProviderChain).toHaveLength(1);
    expect(credProviderCalls.fromIni).toHaveLength(0);
  });
});

describe("AWSElastiCacheBackend factory error wrapping", () => {
  it("wraps a credential-resolution failure in CacheConnectionError with the IAM message", async () => {
    // The reserved "explode" profile makes the resolveCredentials thunk reject;
    // fromIamAuth's catch wraps it with its exact IAM-specific prefix and the
    // original message via describe(e) (kills the message string + describe mutants).
    await expect(
      AWSElastiCacheBackend.fromIamAuth({
        host: "h",
        username: "u",
        region: "us-east-1",
        profileName: "explode",
      }),
    ).rejects.toThrow("Failed to connect to ElastiCache (IAM): boom-profile-load");
    await expect(
      AWSElastiCacheBackend.fromIamAuth({
        host: "h",
        username: "u",
        region: "us-east-1",
        profileName: "explode",
      }),
    ).rejects.toBeInstanceOf(CacheConnectionError);
    expect(credProviderCalls.fromIni[0]).toEqual({ profile: "explode" });
  });
});

describe("AzureRedisCacheBackend factory wiring", () => {
  it("fromAccessKey defaults port 6380/db, sets password, tls {} when ssl default true", async () => {
    await AzureRedisCacheBackend.fromAccessKey({ host: "h", accessKey: "key123" });
    const opts = lastClient().options;
    expect(opts.host).toBe("h");
    expect(opts.port).toBe(6380);
    expect(opts.db).toBe(0);
    expect(opts.password).toBe("key123");
    expect(opts.tls).toEqual({});
  });

  it("fromAccessKey with ssl:false omits tls", async () => {
    await AzureRedisCacheBackend.fromAccessKey({ host: "h", accessKey: "key123", ssl: false });
    const opts = lastClient().options;
    expect(opts.password).toBe("key123");
    expect("tls" in opts).toBe(false);
  });

  it("fromAccessKey honors explicit port and db", async () => {
    await AzureRedisCacheBackend.fromAccessKey({ host: "h", accessKey: "k", port: 6379, db: 5 });
    const opts = lastClient().options;
    expect(opts.port).toBe(6379);
    expect(opts.db).toBe(5);
  });

  it("fromManagedIdentity sets username + entra-token password and tls, refreshes on close", async () => {
    await AzureRedisCacheBackend.fromManagedIdentity({ host: "h", username: "user@scope" });
    const client = lastClient();
    const opts = client.options;
    expect(opts.host).toBe("h");
    expect(opts.port).toBe(6380);
    expect(opts.username).toBe("user@scope");
    expect(opts.password).toBe("entra-token-1");
    expect(opts.tls).toEqual({});
    // No clientId supplied -> credential constructed without one.
    expect(lastClientId.value).toBeUndefined();

    // R2-1: refresh handler registered on "close" only.
    expect(client.handlers.close).toHaveLength(1);
    expect(client.handlers.end).toBeUndefined();
    expect(client.handlers.error).toBeUndefined();

    await fireClose(client, "entra-token-1");
    expect(client.options.password).toBe("entra-token-2");
  });

  it("fromManagedIdentity threads decodeResponses onto the backend", async () => {
    const backend = await AzureRedisCacheBackend.fromManagedIdentity({
      host: "h",
      username: "u",
      decodeResponses: true,
    });
    expect((backend as unknown as { decodeResponses: boolean }).decodeResponses).toBe(true);
  });

  it("fromManagedIdentity passes clientId to the credential and honors ssl:false", async () => {
    await AzureRedisCacheBackend.fromManagedIdentity({
      host: "h",
      username: "u",
      clientId: "client-abc",
      ssl: false,
    });
    expect(lastClientId.value).toBe("client-abc");
    expect("tls" in lastClient().options).toBe(false);
  });

  it("fromServicePrincipal forwards tenant/client/secret and wires token password", async () => {
    await AzureRedisCacheBackend.fromServicePrincipal({
      host: "h",
      username: "sp-user",
      tenantId: "tenant-1",
      clientId: "client-1",
      clientSecret: "secret-1",
    });
    expect(lastServicePrincipalArgs).toEqual({
      tenantId: "tenant-1",
      clientId: "client-1",
      clientSecret: "secret-1",
    });
    const client = lastClient();
    expect(client.options.username).toBe("sp-user");
    expect(client.options.password).toBe("entra-token-1");
    expect(client.options.tls).toEqual({});

    // R2-1: refresh handler registered on "close" only.
    expect(client.handlers.close).toHaveLength(1);
    expect(client.handlers.end).toBeUndefined();
    expect(client.handlers.error).toBeUndefined();

    await fireClose(client, "entra-token-1");
    expect(client.options.password).toBe("entra-token-2");
  });
});
