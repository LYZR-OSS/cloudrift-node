import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getSecrets } from "../../src/index.js";
import type { SecretBackend } from "../../src/index.js";
import { SecretError } from "../../src/core/errors.js";
import { awsOptions, uniqueName } from "./harness.js";

/**
 * Black-box AWS Secrets Manager behavior against LocalStack, driven through the
 * public `getSecrets("aws_secrets_manager", ...)` factory. Proves the
 * create/update branch of `setSecret`, round-trip reads, JSON parsing, prefix
 * filtering on `listSecrets`, and delete visibility — behavior that command-shape
 * mocks cannot establish.
 */
describe("AWS Secrets Manager (LocalStack)", () => {
  let secrets: SecretBackend;
  const created: string[] = [];

  function track(name: string): string {
    created.push(name);
    return name;
  }

  beforeAll(async () => {
    secrets = await getSecrets("aws_secrets_manager", awsOptions());
  });

  afterAll(async () => {
    // deleteSecret force-deletes (ForceDeleteWithoutRecovery), so cleanup is
    // idempotent for already-removed secrets.
    for (const name of created) {
      try {
        await secrets.deleteSecret(name);
      } catch {
        /* already gone */
      }
    }
    await secrets.close();
  });

  it("creates then reads back a secret", async () => {
    const name = track(uniqueName("secret"));
    await secrets.setSecret(name, "initial-value");
    expect(await secrets.getSecret(name)).toBe("initial-value");
  });

  it("updates an existing secret to the latest value", async () => {
    const name = track(uniqueName("secret"));
    await secrets.setSecret(name, "v1");
    await secrets.setSecret(name, "v2");
    expect(await secrets.getSecret(name)).toBe("v2");
  });

  it("parses a JSON secret value", async () => {
    const name = track(uniqueName("secret"));
    await secrets.setSecret(name, JSON.stringify({ user: "lyzr", roles: ["admin", "ops"] }));
    expect(await secrets.getSecretJson(name)).toEqual({ user: "lyzr", roles: ["admin", "ops"] });
  });

  it("lists secrets filtered by prefix", async () => {
    const prefix = uniqueName("listpfx");
    const a = track(`${prefix}-a`);
    const b = track(`${prefix}-b`);
    const other = track(uniqueName("other"));
    await secrets.setSecret(a, "1");
    await secrets.setSecret(b, "2");
    await secrets.setSecret(other, "3");

    const listed = await secrets.listSecrets(prefix);
    expect(listed.sort()).toEqual([a, b].sort());
    expect(listed).not.toContain(other);
  });

  it("deletes so the secret is gone and reports healthy", async () => {
    const name = track(uniqueName("secret"));
    await secrets.setSecret(name, "doomed");
    expect(await secrets.getSecret(name)).toBe("doomed");

    await secrets.deleteSecret(name);

    await expect(secrets.getSecret(name)).rejects.toBeInstanceOf(SecretError);
    expect(await secrets.healthCheck()).toBe(true);
  });
});
