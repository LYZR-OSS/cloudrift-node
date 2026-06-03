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

import { SecretError, SecretNotFoundError, SecretPermissionError } from "../src/core/errors.js";
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
