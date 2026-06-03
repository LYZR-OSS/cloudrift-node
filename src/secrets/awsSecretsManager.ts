import type {
  SecretsManagerClient,
  SecretsManagerClientConfig,
} from "@aws-sdk/client-secrets-manager";

import { SecretError, SecretNotFoundError, SecretPermissionError } from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { SecretBackend } from "./base.js";

const PROVIDER = "aws_secrets_manager";
const SDK_PACKAGE = "@aws-sdk/client-secrets-manager";

/** Shape of the lazily imported `@aws-sdk/client-secrets-manager` module. */
interface SecretsManagerSdk {
  SecretsManagerClient: typeof import("@aws-sdk/client-secrets-manager").SecretsManagerClient;
  GetSecretValueCommand: typeof import("@aws-sdk/client-secrets-manager").GetSecretValueCommand;
  PutSecretValueCommand: typeof import("@aws-sdk/client-secrets-manager").PutSecretValueCommand;
  CreateSecretCommand: typeof import("@aws-sdk/client-secrets-manager").CreateSecretCommand;
  DeleteSecretCommand: typeof import("@aws-sdk/client-secrets-manager").DeleteSecretCommand;
  ListSecretsCommand: typeof import("@aws-sdk/client-secrets-manager").ListSecretsCommand;
  paginateListSecrets: typeof import("@aws-sdk/client-secrets-manager").paginateListSecrets;
}

/** Common AWS client tuning options. */
export interface AwsClientOptions {
  endpointUrl?: string;
  maxPoolConnections?: number;
  connectTimeout?: number;
  readTimeout?: number;
}

export interface AwsAccessKeyOptions extends AwsClientOptions {
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken?: string;
  region?: string;
}

export interface AwsIamRoleOptions extends AwsClientOptions {
  region?: string;
}

export interface AwsProfileOptions extends AwsClientOptions {
  profileName: string;
  region?: string;
}

interface BackendConfig {
  clientConfig: SecretsManagerClientConfig;
  endpointUrl?: string;
  maxPoolConnections: number;
  connectTimeout: number;
  readTimeout: number;
  profileName?: string;
}

/**
 * AWS Secrets Manager backend.
 *
 * A single client is created lazily on first use (behind a memoized promise)
 * and reused for the lifetime of the backend.
 *
 * Construct via one of the static factory methods:
 * - {@link fromAccessKey} — static credentials (+ optional session token)
 * - {@link fromIamRole}   — instance profile / environment / ECS task role
 * - {@link fromProfile}   — named profile from `~/.aws/credentials`
 */
export class AWSSecretsManagerBackend extends SecretBackend {
  readonly #config: BackendConfig;
  #sdk: SecretsManagerSdk | undefined;
  #client: SecretsManagerClient | undefined;
  #ensurePromise: Promise<SecretsManagerClient> | undefined;

  private constructor(config: BackendConfig) {
    super();
    this.#config = config;
  }

  static fromAccessKey(opts: AwsAccessKeyOptions): AWSSecretsManagerBackend {
    const clientConfig: SecretsManagerClientConfig = {
      region: opts.region ?? "us-east-1",
      credentials: {
        accessKeyId: opts.awsAccessKeyId,
        secretAccessKey: opts.awsSecretAccessKey,
        sessionToken: opts.awsSessionToken,
      },
    };
    return new AWSSecretsManagerBackend(buildConfig(clientConfig, opts));
  }

  static fromIamRole(opts: AwsIamRoleOptions = {}): AWSSecretsManagerBackend {
    const clientConfig: SecretsManagerClientConfig = {
      region: opts.region ?? "us-east-1",
    };
    return new AWSSecretsManagerBackend(buildConfig(clientConfig, opts));
  }

  static fromProfile(opts: AwsProfileOptions): AWSSecretsManagerBackend {
    const clientConfig: SecretsManagerClientConfig = {
      region: opts.region ?? "us-east-1",
    };
    return new AWSSecretsManagerBackend({
      ...buildConfig(clientConfig, opts),
      profileName: opts.profileName,
    });
  }

  // ------------------------------------------------------------------
  // Internal lifecycle
  // ------------------------------------------------------------------

  async #ensure(): Promise<SecretsManagerClient> {
    if (this.#client) {
      return this.#client;
    }
    if (!this.#ensurePromise) {
      this.#ensurePromise = this.#createClient();
    }
    return this.#ensurePromise;
  }

  async #createClient(): Promise<SecretsManagerClient> {
    const sdk = await loadOptional<SecretsManagerSdk>(SDK_PACKAGE, PROVIDER);
    this.#sdk = sdk;
    const config: SecretsManagerClientConfig = { ...this.#config.clientConfig };
    if (this.#config.endpointUrl !== undefined) {
      config.endpoint = this.#config.endpointUrl;
    }
    if (this.#config.profileName !== undefined) {
      const credsMod = await loadOptional<typeof import("@aws-sdk/credential-providers")>(
        "@aws-sdk/credential-providers",
        PROVIDER,
      );
      config.credentials = credsMod.fromIni({ profile: this.#config.profileName });
    }
    config.requestHandler = {
      connectionTimeout: this.#config.connectTimeout * 1000,
      requestTimeout: this.#config.readTimeout * 1000,
      httpsAgent: { maxSockets: this.#config.maxPoolConnections },
      httpAgent: { maxSockets: this.#config.maxPoolConnections },
    } as SecretsManagerClientConfig["requestHandler"];
    const client = new sdk.SecretsManagerClient(config);
    this.#client = client;
    return client;
  }

  #requireSdk(): SecretsManagerSdk {
    if (!this.#sdk) {
      throw new SecretError("AWS Secrets Manager client is not initialized");
    }
    return this.#sdk;
  }

  override async close(): Promise<void> {
    if (this.#client) {
      this.#client.destroy();
      this.#client = undefined;
    }
    this.#ensurePromise = undefined;
  }

  // ------------------------------------------------------------------
  // SecretBackend implementation
  // ------------------------------------------------------------------

  async getSecret(name: string): Promise<string> {
    const client = await this.#ensure();
    const sdk = this.#requireSdk();
    try {
      const response = await client.send(new sdk.GetSecretValueCommand({ SecretId: name }));
      // Python returns response["SecretString"], which raises KeyError when the
      // field is absent (e.g. a binary-only secret). Hard-fail to match instead
      // of silently coercing to "".
      if (response.SecretString === undefined) {
        throw new SecretError(`Secret has no string value: ${name}`);
      }
      return response.SecretString;
    } catch (err) {
      throw mapError(err, name);
    }
  }

  async setSecret(name: string, value: string): Promise<void> {
    const client = await this.#ensure();
    const sdk = this.#requireSdk();
    try {
      await client.send(new sdk.PutSecretValueCommand({ SecretId: name, SecretString: value }));
    } catch (err) {
      if (errorName(err) === "ResourceNotFoundException") {
        // Python only wraps the put_secret_value ClientError; a failure of the
        // create_secret fallback propagates as the raw SDK error (unmapped).
        await client.send(new sdk.CreateSecretCommand({ Name: name, SecretString: value }));
        return;
      }
      throw mapError(err, name);
    }
  }

  async deleteSecret(name: string): Promise<void> {
    const client = await this.#ensure();
    const sdk = this.#requireSdk();
    try {
      await client.send(
        new sdk.DeleteSecretCommand({
          SecretId: name,
          ForceDeleteWithoutRecovery: true,
        }),
      );
    } catch (err) {
      throw mapError(err, name);
    }
  }

  async listSecrets(prefix = ""): Promise<string[]> {
    const client = await this.#ensure();
    const sdk = this.#requireSdk();
    try {
      const names: string[] = [];
      const input = prefix ? { Filters: [{ Key: "name" as const, Values: [prefix] }] } : {};
      for await (const page of sdk.paginateListSecrets({ client }, input)) {
        for (const secret of page.SecretList ?? []) {
          if (secret.Name) {
            names.push(secret.Name);
          }
        }
      }
      return names;
    } catch (err) {
      throw mapError(err, prefix);
    }
  }

  override async healthCheck(): Promise<boolean> {
    try {
      const client = await this.#ensure();
      const sdk = this.#requireSdk();
      await client.send(new sdk.ListSecretsCommand({ MaxResults: 1 }));
      return true;
    } catch {
      return false;
    }
  }
}

function buildConfig(
  clientConfig: SecretsManagerClientConfig,
  opts: AwsClientOptions,
): BackendConfig {
  return {
    clientConfig,
    endpointUrl: opts.endpointUrl,
    maxPoolConnections: opts.maxPoolConnections ?? 25,
    connectTimeout: opts.connectTimeout ?? 10,
    readTimeout: opts.readTimeout ?? 30,
  };
}

function errorName(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const named = err as { name?: unknown };
  return typeof named.name === "string" ? named.name : undefined;
}

function mapError(err: unknown, name: string): Error {
  if (err instanceof SecretError) {
    return err;
  }
  const code = errorName(err);
  if (code === "ResourceNotFoundException") {
    return new SecretNotFoundError(`Secret not found: ${name}`, { cause: err });
  }
  if (code === "AccessDeniedException" || code === "UnauthorizedAccess") {
    return new SecretPermissionError(`Access denied for secret: ${name}`, {
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new SecretError(message, { cause: err });
}
