import type { TokenCredential } from "@azure/core-auth";
import type { SecretClient } from "@azure/keyvault-secrets";

import {
  SecretError,
  SecretNotFoundError,
  SecretPermissionError,
} from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { SecretBackend } from "./base.js";

const PROVIDER = "azure_keyvault";
const KEYVAULT_PACKAGE = "@azure/keyvault-secrets";
const IDENTITY_PACKAGE = "@azure/identity";

interface KeyVaultSdk {
  SecretClient: typeof import("@azure/keyvault-secrets").SecretClient;
}

interface IdentitySdk {
  ManagedIdentityCredential: typeof import("@azure/identity").ManagedIdentityCredential;
  ClientSecretCredential: typeof import("@azure/identity").ClientSecretCredential;
}

type CredentialFactory = (identity: IdentitySdk) => TokenCredential;

interface BackendConfig {
  vaultUrl: string;
  credentialFactory: CredentialFactory;
}

/**
 * Azure Key Vault secrets backend (native via `@azure/keyvault-secrets`).
 *
 * Construct via one of the static factory methods:
 * - {@link fromManagedIdentity}  — Azure Managed Identity (system or user-assigned)
 * - {@link fromServicePrincipal} — Azure AD service principal (client secret)
 *
 * The SDK client and credential are created lazily on first use behind a
 * memoized promise.
 */
export class AzureKeyVaultBackend extends SecretBackend {
  readonly #config: BackendConfig;
  #client: SecretClient | undefined;
  #credential: TokenCredential | undefined;
  #ensurePromise: Promise<SecretClient> | undefined;

  private constructor(config: BackendConfig) {
    super();
    this.#config = config;
  }

  static fromManagedIdentity(opts: {
    vaultUrl: string;
    clientId?: string;
  }): AzureKeyVaultBackend {
    return new AzureKeyVaultBackend({
      vaultUrl: opts.vaultUrl,
      credentialFactory: (identity) =>
        opts.clientId
          ? new identity.ManagedIdentityCredential({ clientId: opts.clientId })
          : new identity.ManagedIdentityCredential(),
    });
  }

  static fromServicePrincipal(opts: {
    vaultUrl: string;
    tenantId: string;
    clientId: string;
    clientSecret: string;
  }): AzureKeyVaultBackend {
    return new AzureKeyVaultBackend({
      vaultUrl: opts.vaultUrl,
      credentialFactory: (identity) =>
        new identity.ClientSecretCredential(
          opts.tenantId,
          opts.clientId,
          opts.clientSecret,
        ),
    });
  }

  // ------------------------------------------------------------------
  // Internal lifecycle
  // ------------------------------------------------------------------

  async #ensure(): Promise<SecretClient> {
    if (this.#client) {
      return this.#client;
    }
    if (!this.#ensurePromise) {
      this.#ensurePromise = this.#createClient();
    }
    return this.#ensurePromise;
  }

  async #createClient(): Promise<SecretClient> {
    const keyvault = await loadOptional<KeyVaultSdk>(
      KEYVAULT_PACKAGE,
      PROVIDER,
    );
    const identity = await loadOptional<IdentitySdk>(
      IDENTITY_PACKAGE,
      PROVIDER,
    );
    const credential = this.#config.credentialFactory(identity);
    this.#credential = credential;
    const client = new keyvault.SecretClient(this.#config.vaultUrl, credential);
    this.#client = client;
    return client;
  }

  override async close(): Promise<void> {
    const credential = this.#credential as
      | (TokenCredential & { close?: () => Promise<void> })
      | undefined;
    if (credential && typeof credential.close === "function") {
      await credential.close();
    }
    this.#client = undefined;
    this.#credential = undefined;
    this.#ensurePromise = undefined;
  }

  // ------------------------------------------------------------------
  // SecretBackend implementation
  // ------------------------------------------------------------------

  async getSecret(name: string): Promise<string> {
    const client = await this.#ensure();
    try {
      const secret = await client.getSecret(name);
      return secret.value ?? "";
    } catch (err) {
      throw mapError(err, name);
    }
  }

  async setSecret(name: string, value: string): Promise<void> {
    const client = await this.#ensure();
    try {
      await client.setSecret(name, value);
    } catch (err) {
      throw mapError(err, name);
    }
  }

  async deleteSecret(name: string): Promise<void> {
    const client = await this.#ensure();
    try {
      const poller = await client.beginDeleteSecret(name);
      await poller.pollUntilDone();
    } catch (err) {
      throw mapError(err, name);
    }
  }

  async listSecrets(prefix = ""): Promise<string[]> {
    const client = await this.#ensure();
    try {
      const names: string[] = [];
      for await (const props of client.listPropertiesOfSecrets()) {
        if (!prefix || (props.name && props.name.startsWith(prefix))) {
          if (props.name) {
            names.push(props.name);
          }
        }
      }
      return names;
    } catch (err) {
      throw mapError(err, prefix);
    }
  }
}

function statusCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const e = err as { statusCode?: unknown };
  return typeof e.statusCode === "number" ? e.statusCode : undefined;
}

function mapError(err: unknown, name: string): Error {
  const code = statusCode(err);
  const named =
    typeof err === "object" && err !== null
      ? (err as { name?: unknown }).name
      : undefined;
  if (code === 404 || named === "ResourceNotFoundError") {
    return new SecretNotFoundError(`Secret not found: ${name}`, { cause: err });
  }
  if (code === 403) {
    return new SecretPermissionError(`Access denied for secret: ${name}`, {
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new SecretError(message, { cause: err });
}
