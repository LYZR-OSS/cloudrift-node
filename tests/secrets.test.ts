import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
  ListSecretsCommand,
} from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CloudRiftError,
  SecretError,
  SecretNotFoundError,
  SecretPermissionError,
} from "../src/core/errors.js";
import { SecretBackend } from "../src/secrets/base.js";
import {
  AWSSecretsManagerBackend,
  AzureKeyVaultBackend,
  getSecrets,
} from "../src/secrets/index.js";

const smMock = mockClient(SecretsManagerClient);
const credentialProviderMock = vi.hoisted(() => ({
  fromIni: vi.fn(() => async () => ({
    accessKeyId: "profile-key",
    secretAccessKey: "profile-secret",
  })),
}));

vi.mock("@aws-sdk/credential-providers", () => credentialProviderMock);

class FakeRestError extends Error {
  statusCode: number;

  constructor(statusCode: number, message = `status ${statusCode}`) {
    super(message);
    this.name = "RestError";
    this.statusCode = statusCode;
  }
}

const keyVaultHarness = vi.hoisted(() => ({
  secrets: new Map<string, string | undefined>(),
  deleted: [] as string[],
  clients: [] as unknown[],
  credentials: [] as Array<{ kind: string; args: unknown[]; closed: boolean }>,
  failNextClientCreations: 0,
}));

vi.mock("@azure/keyvault-secrets", () => {
  class SecretClient {
    constructor(
      public vaultUrl: string,
      public credential: unknown,
    ) {
      if (keyVaultHarness.failNextClientCreations > 0) {
        keyVaultHarness.failNextClientCreations -= 1;
        throw new Error("key vault init unavailable");
      }
      keyVaultHarness.clients.push(this);
    }

    async getSecret(name: string): Promise<{ value?: string }> {
      if (!keyVaultHarness.secrets.has(name)) {
        throw new FakeRestError(404);
      }
      return { value: keyVaultHarness.secrets.get(name) };
    }

    async setSecret(name: string, value: string): Promise<void> {
      keyVaultHarness.secrets.set(name, value);
    }

    async beginDeleteSecret(name: string): Promise<{ pollUntilDone(): Promise<void> }> {
      if (!keyVaultHarness.secrets.has(name)) {
        throw new FakeRestError(404);
      }
      keyVaultHarness.secrets.delete(name);
      keyVaultHarness.deleted.push(name);
      return { pollUntilDone: async () => undefined };
    }

    async *listPropertiesOfSecrets(): AsyncGenerator<{ name: string }> {
      for (const name of keyVaultHarness.secrets.keys()) {
        yield { name };
      }
    }
  }
  return { SecretClient };
});

vi.mock("@azure/identity", () => {
  class ManagedIdentityCredential {
    record: { kind: string; args: unknown[]; closed: boolean };

    constructor(...args: unknown[]) {
      this.record = { kind: "managed", args, closed: false };
      keyVaultHarness.credentials.push(this.record);
    }

    async close(): Promise<void> {
      this.record.closed = true;
    }
  }

  class ClientSecretCredential {
    record: { kind: string; args: unknown[]; closed: boolean };

    constructor(...args: unknown[]) {
      this.record = { kind: "service-principal", args, closed: false };
      keyVaultHarness.credentials.push(this.record);
    }

    async close(): Promise<void> {
      this.record.closed = true;
    }
  }

  return { ManagedIdentityCredential, ClientSecretCredential };
});

/** Build a botocore-style service exception with a `name`. */
function awsError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

async function makeBackend() {
  return getSecrets("aws_secrets_manager", {
    awsAccessKeyId: "test",
    awsSecretAccessKey: "test",
    region: "us-east-1",
    endpointUrl: "http://localhost:4566",
  });
}

describe("AWSSecretsManagerBackend", () => {
  beforeEach(() => {
    smMock.reset();
    credentialProviderMock.fromIni.mockClear();
  });

  afterEach(() => {
    smMock.reset();
  });

  it("set falls back to create when the secret does not exist", async () => {
    smMock.on(PutSecretValueCommand).rejects(awsError("ResourceNotFoundException"));
    smMock.on(CreateSecretCommand).resolves({ ARN: "arn", Name: "new/secret" });

    const backend = await makeBackend();
    await backend.setSecret("new/secret", "value");

    const createCalls = smMock.commandCalls(CreateSecretCommand);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.args[0].input).toMatchObject({
      Name: "new/secret",
      SecretString: "value",
    });
    await backend.close();
  });

  it("set uses PutSecretValue when the secret exists", async () => {
    smMock.on(PutSecretValueCommand).resolves({ ARN: "arn", Name: "exists" });

    const backend = await makeBackend();
    await backend.setSecret("exists", "v2");

    expect(smMock.commandCalls(PutSecretValueCommand)).toHaveLength(1);
    expect(smMock.commandCalls(CreateSecretCommand)).toHaveLength(0);
    await backend.close();
  });

  it("gets a secret value", async () => {
    smMock.on(GetSecretValueCommand).resolves({ SecretString: "s3cr3t-value" });

    const backend = await makeBackend();
    expect(await backend.getSecret("my/secret")).toBe("s3cr3t-value");
    await backend.close();
  });

  it("resolves named profiles through fromIni credentials", async () => {
    smMock.on(ListSecretsCommand).resolves({ SecretList: [] });

    const backend = await getSecrets("aws_secrets_manager", {
      profileName: "dev",
      region: "us-east-1",
    });
    expect(await backend.healthCheck()).toBe(true);

    expect(credentialProviderMock.fromIni).toHaveBeenCalledWith({ profile: "dev" });
    await backend.close();
  });

  it("parses a JSON secret", async () => {
    const payload = { db_host: "localhost", db_port: 5432 };
    smMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify(payload) });

    const backend = await makeBackend();
    expect(await backend.getSecretJson("json/secret")).toEqual(payload);
    await backend.close();
  });

  it("throws SecretError for invalid JSON", async () => {
    smMock.on(GetSecretValueCommand).resolves({ SecretString: "not json{" });

    const backend = await makeBackend();
    await expect(backend.getSecretJson("bad/json")).rejects.toBeInstanceOf(SecretError);
    await backend.close();
  });

  it("deletes a secret with ForceDeleteWithoutRecovery", async () => {
    smMock.on(DeleteSecretCommand).resolves({});

    const backend = await makeBackend();
    await backend.deleteSecret("to/delete");

    const calls = smMock.commandCalls(DeleteSecretCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toMatchObject({
      SecretId: "to/delete",
      ForceDeleteWithoutRecovery: true,
    });
    await backend.close();
  });

  it("lists secrets without a prefix", async () => {
    smMock.on(ListSecretsCommand).resolves({
      SecretList: [{ Name: "svc/alpha" }, { Name: "svc/beta" }],
    });

    const backend = await makeBackend();
    const names = await backend.listSecrets();
    expect(names).toContain("svc/alpha");
    expect(names).toContain("svc/beta");

    const calls = smMock.commandCalls(ListSecretsCommand);
    expect(calls[0]!.args[0].input).toEqual({});
    await backend.close();
  });

  it("lists secrets with a name filter when a prefix is given", async () => {
    smMock.on(ListSecretsCommand).resolves({
      SecretList: [{ Name: "prefix/one" }, { Name: "prefix/two" }],
    });

    const backend = await makeBackend();
    const names = await backend.listSecrets("prefix/");
    expect(names.every((n) => n.startsWith("prefix/"))).toBe(true);

    const calls = smMock.commandCalls(ListSecretsCommand);
    expect(calls[0]!.args[0].input).toEqual({
      Filters: [{ Key: "name", Values: ["prefix/"] }],
    });
    await backend.close();
  });

  it("maps ResourceNotFoundException to SecretNotFoundError", async () => {
    smMock.on(GetSecretValueCommand).rejects(awsError("ResourceNotFoundException"));

    const backend = await makeBackend();
    await expect(backend.getSecret("missing")).rejects.toBeInstanceOf(SecretNotFoundError);
    await backend.close();
  });

  it("maps AccessDeniedException to SecretPermissionError", async () => {
    smMock.on(GetSecretValueCommand).rejects(awsError("AccessDeniedException"));

    const backend = await makeBackend();
    await expect(backend.getSecret("denied")).rejects.toBeInstanceOf(SecretPermissionError);
    await backend.close();
  });

  it("reports healthy when ListSecrets succeeds", async () => {
    smMock.on(ListSecretsCommand).resolves({ SecretList: [] });

    const backend = await makeBackend();
    expect(await backend.healthCheck()).toBe(true);
    await backend.close();
  });

  it("reports unhealthy when ListSecrets fails", async () => {
    smMock.on(ListSecretsCommand).rejects(awsError("AccessDeniedException"));

    const backend = await makeBackend();
    expect(await backend.healthCheck()).toBe(false);
    await backend.close();
  });

  it("getSecret throws SecretError with the exact message when SecretBinary-only (no SecretString)", async () => {
    smMock.on(GetSecretValueCommand).resolves({
      SecretBinary: new TextEncoder().encode("binary"),
    });

    const backend = await makeBackend();
    // L180 ConditionalExpression / L181 StringLiteral: exact message including name.
    await expect(backend.getSecret("bin/secret")).rejects.toBeInstanceOf(SecretError);
    await expect(backend.getSecret("bin/secret")).rejects.toThrow(
      "Secret has no string value: bin/secret",
    );
    // The GetSecretValueCommand carries the SecretId. (L176 ObjectLiteral)
    const calls = smMock.commandCalls(GetSecretValueCommand);
    expect(calls[0]!.args[0].input).toEqual({ SecretId: "bin/secret" });
    await backend.close();
  });

  it("getSecret returns SecretString even when it is the empty string", async () => {
    smMock.on(GetSecretValueCommand).resolves({ SecretString: "" });

    const backend = await makeBackend();
    // L180 uses `=== undefined`, not falsy: an empty string must be returned, not thrown.
    await expect(backend.getSecret("empty/string")).resolves.toBe("");
    await backend.close();
  });

  it("set falls back to create and issues PutSecretValue first then CreateSecret", async () => {
    smMock.on(PutSecretValueCommand).rejects(awsError("ResourceNotFoundException"));
    smMock.on(CreateSecretCommand).resolves({ ARN: "arn", Name: "new/secret" });

    const backend = await makeBackend();
    await backend.setSecret("new/secret", "value");

    // L193 ObjectLiteral: PutSecretValue carries SecretId + SecretString.
    const putCalls = smMock.commandCalls(PutSecretValueCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]!.args[0].input).toEqual({
      SecretId: "new/secret",
      SecretString: "value",
    });
    // L198 ObjectLiteral: CreateSecret uses Name (not SecretId) + SecretString.
    const createCalls = smMock.commandCalls(CreateSecretCommand);
    expect(createCalls[0]!.args[0].input).toEqual({
      Name: "new/secret",
      SecretString: "value",
    });
    await backend.close();
  });

  it("set surfaces a non-ResourceNotFound put failure as a mapped error (no create fallback)", async () => {
    smMock.on(PutSecretValueCommand).rejects(awsError("AccessDeniedException"));

    const backend = await makeBackend();
    // L195 ConditionalExpression: only ResourceNotFoundException triggers create.
    await expect(backend.setSecret("denied", "v")).rejects.toBeInstanceOf(SecretPermissionError);
    expect(smMock.commandCalls(CreateSecretCommand)).toHaveLength(0);
    await backend.close();
  });

  it("deleteSecret maps a delete failure through mapError", async () => {
    smMock.on(DeleteSecretCommand).rejects(awsError("ResourceNotFoundException"));

    const backend = await makeBackend();
    await expect(backend.deleteSecret("gone")).rejects.toBeInstanceOf(SecretNotFoundError);
    await backend.close();
  });

  it("listSecrets returns an empty array when a page has no SecretList", async () => {
    smMock.on(ListSecretsCommand).resolves({});

    const backend = await makeBackend();
    // L227 ArrayDeclaration `?? []`: a missing SecretList must not crash.
    await expect(backend.listSecrets()).resolves.toEqual([]);
    await backend.close();
  });

  it("listSecrets skips entries without a Name", async () => {
    smMock.on(ListSecretsCommand).resolves({
      SecretList: [{ Name: "has/name" }, { ARN: "arn-only" }, { Name: "" }],
    });

    const backend = await makeBackend();
    // L228 ConditionalExpression: only truthy Name values are pushed.
    await expect(backend.listSecrets()).resolves.toEqual(["has/name"]);
    await backend.close();
  });

  it("listSecrets maps a pagination failure through mapError with the prefix as name", async () => {
    smMock.on(ListSecretsCommand).rejects(awsError("AccessDeniedException"));

    const backend = await makeBackend();
    await expect(backend.listSecrets("p/")).rejects.toBeInstanceOf(SecretPermissionError);
    await expect(backend.listSecrets("p/")).rejects.toThrow("Access denied for secret: p/");
    await backend.close();
  });

  it("maps UnauthorizedAccess to SecretPermissionError with exact message", async () => {
    smMock.on(GetSecretValueCommand).rejects(awsError("UnauthorizedAccess"));

    const backend = await makeBackend();
    // L280 LogicalOperator + L281 StringLiteral.
    await expect(backend.getSecret("u")).rejects.toBeInstanceOf(SecretPermissionError);
    await expect(backend.getSecret("u")).rejects.toThrow("Access denied for secret: u");
    await backend.close();
  });

  it("maps ResourceNotFoundException with the exact 'Secret not found' message", async () => {
    smMock.on(GetSecretValueCommand).rejects(awsError("ResourceNotFoundException"));

    const backend = await makeBackend();
    // L277/L278 StringLiteral exact message.
    await expect(backend.getSecret("missing/x")).rejects.toThrow("Secret not found: missing/x");
    await backend.close();
  });

  it("maps an unknown SDK error to SecretError preserving the message and cause", async () => {
    const raw = awsError("ThrottlingException");
    raw.message = "rate exceeded";
    smMock.on(GetSecretValueCommand).rejects(raw);

    const backend = await makeBackend();
    // L285 ConditionalExpression: err instanceof Error => use err.message.
    await expect(backend.getSecret("any")).rejects.toBeInstanceOf(SecretError);
    await expect(backend.getSecret("any")).rejects.toThrow("rate exceeded");
    await backend.close();
  });

  it("a re-thrown SecretError passes through mapError unchanged (instanceof short-circuit)", async () => {
    // SecretBinary-only path throws a SecretError inside the try; mapError (L273)
    // must return it as-is rather than re-wrapping it as a generic SecretError.
    smMock.on(GetSecretValueCommand).resolves({ SecretBinary: new Uint8Array([1]) });

    const backend = await makeBackend();
    await expect(backend.getSecret("bin")).rejects.toThrow("Secret has no string value: bin");
    await backend.close();
  });

  it("healthCheck sends ListSecretsCommand with MaxResults of exactly 1", async () => {
    smMock.on(ListSecretsCommand).resolves({ SecretList: [] });

    const backend = await makeBackend();
    expect(await backend.healthCheck()).toBe(true);

    // L243 ObjectLiteral: MaxResults: 1.
    const calls = smMock.commandCalls(ListSecretsCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({ MaxResults: 1 });
    await backend.close();
  });

  it("retries lazy client creation after a failed profile init", async () => {
    smMock.on(GetSecretValueCommand).resolves({ SecretString: "retried" });
    credentialProviderMock.fromIni
      .mockImplementationOnce(() => {
        throw new Error("profile unavailable");
      })
      .mockReturnValueOnce(async () => ({
        accessKeyId: "retry-key",
        secretAccessKey: "retry-secret",
      }));
    const backend = AWSSecretsManagerBackend.fromProfile({
      profileName: "dev",
      region: "us-east-1",
    });

    await expect(backend.getSecret("first")).rejects.toThrow(/profile unavailable/);
    await expect(backend.getSecret("second")).resolves.toBe("retried");

    expect(credentialProviderMock.fromIni).toHaveBeenCalledTimes(2);
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    await backend.close();
  });
});

describe("AzureKeyVaultBackend (fake)", () => {
  beforeEach(() => {
    keyVaultHarness.secrets.clear();
    keyVaultHarness.deleted = [];
    keyVaultHarness.clients = [];
    keyVaultHarness.credentials = [];
    keyVaultHarness.failNextClientCreations = 0;
  });

  it("dispatches managed identity auth and performs CRUD with prefix listing", async () => {
    const backend = (await getSecrets("azure_keyvault", {
      vaultUrl: "https://vault.vault.azure.net",
      clientId: "managed-client",
    })) as AzureKeyVaultBackend;

    await backend.setSecret("app/a", "one");
    await backend.setSecret("app/b", "two");
    await backend.setSecret("other/c", "three");

    expect(await backend.getSecret("app/a")).toBe("one");
    expect(new Set(await backend.listSecrets("app/"))).toEqual(new Set(["app/a", "app/b"]));

    await backend.deleteSecret("app/a");
    await expect(backend.getSecret("app/a")).rejects.toBeInstanceOf(SecretNotFoundError);
    expect(keyVaultHarness.deleted).toEqual(["app/a"]);
    expect(keyVaultHarness.credentials[0]).toMatchObject({
      kind: "managed",
      args: [{ clientId: "managed-client" }],
    });

    await backend.close();
    expect(keyVaultHarness.credentials[0]?.closed).toBe(true);
  });

  it("dispatches service principal auth", async () => {
    const backend = await getSecrets("azure_keyvault", {
      vaultUrl: "https://vault.vault.azure.net",
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
    });

    await backend.setSecret("name", "value");

    expect(keyVaultHarness.credentials[0]).toMatchObject({
      kind: "service-principal",
      args: ["tenant", "client", "secret"],
    });
    await backend.close();
  });

  it("maps permission failures and coerces nullish secret values to empty strings", async () => {
    keyVaultHarness.secrets.set("empty", undefined);
    const backend = AzureKeyVaultBackend.fromManagedIdentity({
      vaultUrl: "https://vault.vault.azure.net",
    });

    await expect(backend.getSecret("empty")).resolves.toBe("");

    const originalGet = keyVaultHarness.secrets.get.bind(keyVaultHarness.secrets);
    keyVaultHarness.secrets.set("denied", "value");
    keyVaultHarness.secrets.get = () => {
      throw new FakeRestError(403);
    };
    await expect(backend.getSecret("denied")).rejects.toBeInstanceOf(SecretPermissionError);
    keyVaultHarness.secrets.get = originalGet;
    await backend.close();
  });

  it("getSecret coerces an undefined value to an empty string but returns a real value verbatim", async () => {
    keyVaultHarness.secrets.set("present", "real-value");
    keyVaultHarness.secrets.set("nullish", undefined);
    const backend = AzureKeyVaultBackend.fromManagedIdentity({
      vaultUrl: "https://vault.vault.azure.net",
    });
    // L129 `secret.value ?? ""`.
    await expect(backend.getSecret("present")).resolves.toBe("real-value");
    await expect(backend.getSecret("nullish")).resolves.toBe("");
    await backend.close();
  });

  it("listSecrets with a prefix keeps only names that start with the prefix", async () => {
    keyVaultHarness.secrets.set("app/a", "1");
    keyVaultHarness.secrets.set("app/b", "2");
    keyVaultHarness.secrets.set("other/c", "3");
    const backend = AzureKeyVaultBackend.fromManagedIdentity({
      vaultUrl: "https://vault.vault.azure.net",
    });
    // L159/L160 ConditionalExpression: prefix filter via startsWith.
    expect(new Set(await backend.listSecrets("app/"))).toEqual(new Set(["app/a", "app/b"]));
    await backend.close();
  });

  it("listSecrets with no prefix returns every name", async () => {
    keyVaultHarness.secrets.set("app/a", "1");
    keyVaultHarness.secrets.set("other/c", "3");
    const backend = AzureKeyVaultBackend.fromManagedIdentity({
      vaultUrl: "https://vault.vault.azure.net",
    });
    // L159 `!prefix` branch (empty prefix => include all).
    expect(new Set(await backend.listSecrets())).toEqual(new Set(["app/a", "other/c"]));
    await backend.close();
  });

  it("maps a 404 to SecretNotFoundError with the exact message", async () => {
    const backend = AzureKeyVaultBackend.fromManagedIdentity({
      vaultUrl: "https://vault.vault.azure.net",
    });
    // L184 StringLiteral: exact "Secret not found: <name>".
    await expect(backend.getSecret("ghost")).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(backend.getSecret("ghost")).rejects.toThrow("Secret not found: ghost");
    await backend.close();
  });

  it("maps a ResourceNotFoundError name (no statusCode) to SecretNotFoundError", async () => {
    keyVaultHarness.secrets.set("named", "v");
    const backend = AzureKeyVaultBackend.fromManagedIdentity({
      vaultUrl: "https://vault.vault.azure.net",
    });
    const originalGet = keyVaultHarness.secrets.get.bind(keyVaultHarness.secrets);
    keyVaultHarness.secrets.get = () => {
      const e = new Error("not found");
      e.name = "ResourceNotFoundError";
      throw e;
    };
    // L183/L184 LogicalOperator: named === "ResourceNotFoundError" branch.
    await expect(backend.getSecret("named")).rejects.toBeInstanceOf(SecretNotFoundError);
    keyVaultHarness.secrets.get = originalGet;
    await backend.close();
  });

  it("maps a 403 to SecretPermissionError with the exact message", async () => {
    keyVaultHarness.secrets.set("locked", "v");
    const backend = AzureKeyVaultBackend.fromManagedIdentity({
      vaultUrl: "https://vault.vault.azure.net",
    });
    const originalGet = keyVaultHarness.secrets.get.bind(keyVaultHarness.secrets);
    keyVaultHarness.secrets.get = () => {
      throw new FakeRestError(403);
    };
    // L187/L188 StringLiteral.
    await expect(backend.getSecret("locked")).rejects.toThrow("Access denied for secret: locked");
    keyVaultHarness.secrets.get = originalGet;
    await backend.close();
  });

  it("maps an unknown Error to SecretError preserving the message", async () => {
    keyVaultHarness.secrets.set("boom", "v");
    const backend = AzureKeyVaultBackend.fromManagedIdentity({
      vaultUrl: "https://vault.vault.azure.net",
    });
    const originalGet = keyVaultHarness.secrets.get.bind(keyVaultHarness.secrets);
    keyVaultHarness.secrets.get = () => {
      throw new Error("kv exploded");
    };
    // L192/L193: err instanceof Error => message preserved, wrapped in SecretError.
    await expect(backend.getSecret("boom")).rejects.toBeInstanceOf(SecretError);
    await expect(backend.getSecret("boom")).rejects.toThrow("kv exploded");
    keyVaultHarness.secrets.get = originalGet;
    await backend.close();
  });

  it("maps a non-Error throw (string) to SecretError stringifying the value", async () => {
    keyVaultHarness.secrets.set("strthrow", "v");
    const backend = AzureKeyVaultBackend.fromManagedIdentity({
      vaultUrl: "https://vault.vault.azure.net",
    });
    const originalGet = keyVaultHarness.secrets.get.bind(keyVaultHarness.secrets);
    keyVaultHarness.secrets.get = () => {
      throw "plain string failure";
    };
    // L183 typeof/null guards + L192 String(err) branch.
    await expect(backend.getSecret("strthrow")).rejects.toBeInstanceOf(SecretError);
    await expect(backend.getSecret("strthrow")).rejects.toThrow("plain string failure");
    keyVaultHarness.secrets.get = originalGet;
    await backend.close();
  });

  it("setSecret writes the value and listSecrets/deleteSecret round-trip the name", async () => {
    const backend = AzureKeyVaultBackend.fromManagedIdentity({
      vaultUrl: "https://vault.vault.azure.net",
    });
    await backend.setSecret("k", "the-value");
    expect(keyVaultHarness.secrets.get("k")).toBe("the-value");
    await backend.deleteSecret("k");
    expect(keyVaultHarness.deleted).toEqual(["k"]);
    await backend.close();
  });

  it("retries lazy client creation after the first initialization fails", async () => {
    keyVaultHarness.failNextClientCreations = 1;
    const backend = AzureKeyVaultBackend.fromManagedIdentity({
      vaultUrl: "https://vault.vault.azure.net",
    });

    await expect(backend.setSecret("first", "value")).rejects.toThrow(/key vault init unavailable/);
    await expect(backend.setSecret("second", "value")).resolves.toBeUndefined();

    expect(keyVaultHarness.clients).toHaveLength(1);
    expect(keyVaultHarness.credentials).toHaveLength(2);
    expect(keyVaultHarness.credentials[0].closed).toBe(true);
    expect(keyVaultHarness.credentials[1].closed).toBe(false);
    expect(keyVaultHarness.secrets.get("second")).toBe("value");
    await backend.close();
    expect(keyVaultHarness.credentials[1].closed).toBe(true);
  });
});

describe("getSecrets factory", () => {
  it("normalizes provider values from config", async () => {
    const backend = await getSecrets(" AWS_SECRETS_MANAGER ", {
      region: "us-east-1",
    });
    expect(backend).toBeInstanceOf(AWSSecretsManagerBackend);
    await backend.close();
  });

  it("throws for an unknown provider", async () => {
    await expect(
      getSecrets("gcp_secret_manager" as unknown as "aws_secrets_manager", { project: "my-proj" }),
    ).rejects.toThrow(/Unknown secrets provider/);
  });
});

describe("getSecrets factory dispatch", () => {
  beforeEach(() => {
    keyVaultHarness.secrets.clear();
    keyVaultHarness.deleted = [];
    keyVaultHarness.clients = [];
    keyVaultHarness.credentials = [];
    keyVaultHarness.failNextClientCreations = 0;
    credentialProviderMock.fromIni.mockClear();
  });

  it("aws + awsAccessKeyId dispatches to fromAccessKey", async () => {
    const spy = vi.spyOn(AWSSecretsManagerBackend, "fromAccessKey");
    const backend = await getSecrets("aws_secrets_manager", {
      awsAccessKeyId: "id",
      awsSecretAccessKey: "secret",
      region: "us-east-1",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(backend).toBeInstanceOf(AWSSecretsManagerBackend);
    await backend.close();
    spy.mockRestore();
  });

  it("aws + profileName dispatches to fromProfile", async () => {
    const spy = vi.spyOn(AWSSecretsManagerBackend, "fromProfile");
    const backend = await getSecrets("aws_secrets_manager", {
      profileName: "dev",
      region: "us-east-1",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(backend).toBeInstanceOf(AWSSecretsManagerBackend);
    await backend.close();
    spy.mockRestore();
  });

  it("aws with neither access key nor profile dispatches to fromIamRole", async () => {
    const spy = vi.spyOn(AWSSecretsManagerBackend, "fromIamRole");
    const backend = await getSecrets("aws_secrets_manager", { region: "us-east-1" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(backend).toBeInstanceOf(AWSSecretsManagerBackend);
    await backend.close();
    spy.mockRestore();
  });

  it("azure + clientSecret dispatches to fromServicePrincipal", async () => {
    const spy = vi.spyOn(AzureKeyVaultBackend, "fromServicePrincipal");
    const backend = await getSecrets("azure_keyvault", {
      vaultUrl: "https://vault.vault.azure.net",
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(backend).toBeInstanceOf(AzureKeyVaultBackend);
    await backend.close();
    spy.mockRestore();
  });

  it("azure without clientSecret dispatches to fromManagedIdentity", async () => {
    const spy = vi.spyOn(AzureKeyVaultBackend, "fromManagedIdentity");
    const backend = await getSecrets("azure_keyvault", {
      vaultUrl: "https://vault.vault.azure.net",
      clientId: "managed-client",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(backend).toBeInstanceOf(AzureKeyVaultBackend);
    await backend.close();
    spy.mockRestore();
  });

  it("throws CloudRiftError on an unknown provider", async () => {
    await expect(
      getSecrets("gcp_secret_manager" as unknown as "aws_secrets_manager", {}),
    ).rejects.toThrow(CloudRiftError);
    await expect(
      getSecrets("gcp_secret_manager" as unknown as "aws_secrets_manager", {}),
    ).rejects.toThrow(/Unknown secrets provider/);
  });
});

describe("SecretBackend default methods", () => {
  /** Minimal concrete backend exercising the abstract base defaults. */
  class FakeBackend extends SecretBackend {
    constructor(private readonly store: Map<string, string>) {
      super();
    }
    async getSecret(name: string): Promise<string> {
      const v = this.store.get(name);
      if (v === undefined) {
        throw new SecretNotFoundError(`missing: ${name}`);
      }
      return v;
    }
    async setSecret(name: string, value: string): Promise<void> {
      this.store.set(name, value);
    }
    async deleteSecret(name: string): Promise<void> {
      this.store.delete(name);
    }
    async listSecrets(prefix = ""): Promise<string[]> {
      return [...this.store.keys()].filter((k) => k.startsWith(prefix));
    }
  }

  it("getSecretJson default JSON-parses getSecret output", async () => {
    const payload = { db_host: "localhost", db_port: 5432, nested: { a: [1, 2] } };
    const backend = new FakeBackend(new Map([["cfg", JSON.stringify(payload)]]));
    expect(await backend.getSecretJson("cfg")).toEqual(payload);
  });

  it("getSecretJson default surfaces a SecretError for invalid JSON", async () => {
    const backend = new FakeBackend(new Map([["bad", "not json{"]]));
    await expect(backend.getSecretJson("bad")).rejects.toBeInstanceOf(SecretError);
    await expect(backend.getSecretJson("bad")).rejects.toThrow(/not valid JSON/);
  });

  it("healthCheck default returns true and probes listSecrets with the health sentinel prefix", async () => {
    const backend = new FakeBackend(new Map());
    const spy = vi.spyOn(backend, "listSecrets");
    expect(await backend.healthCheck()).toBe(true);
    // R2-3: default healthCheck must probe with the sentinel prefix.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("__cloudrift_health__");
    spy.mockRestore();
  });

  it("healthCheck default returns false but still probes listSecrets with the sentinel prefix", async () => {
    const backend = new FakeBackend(new Map());
    const spy = vi.spyOn(backend, "listSecrets").mockImplementation(async () => {
      throw new Error("unreachable");
    });
    expect(await backend.healthCheck()).toBe(false);
    // R2-3: even on the throw path the probe must use the sentinel prefix.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("__cloudrift_health__");
    spy.mockRestore();
  });

  it("close default is a no-op and asyncDispose delegates to close", async () => {
    const backend = new FakeBackend(new Map());
    await expect(backend.close()).resolves.toBeUndefined();
    let closed = false;
    backend.close = async () => {
      closed = true;
    };
    await backend[Symbol.asyncDispose]();
    expect(closed).toBe(true);
  });
});
