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
import { getSecrets } from "../src/secrets/index.js";

const smMock = mockClient(SecretsManagerClient);
const credentialProviderMock = vi.hoisted(() => ({
  fromIni: vi.fn(() => async () => ({
    accessKeyId: "profile-key",
    secretAccessKey: "profile-secret",
  })),
}));

vi.mock("@aws-sdk/credential-providers", () => credentialProviderMock);

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
});

describe("getSecrets factory", () => {
  it("throws for an unknown provider", async () => {
    await expect(
      getSecrets("gcp_secret_manager" as unknown as "aws_secrets_manager", { project: "my-proj" }),
    ).rejects.toThrow(/Unknown secrets provider/);
  });
});
