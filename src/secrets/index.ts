import { normalizeChoice } from "../core/providers.js";
import type { SecretBackend } from "./base.js";
import {
  AWSSecretsManagerBackend,
  type AwsAccessKeyOptions,
  type AwsIamRoleOptions,
  type AwsProfileOptions,
} from "./awsSecretsManager.js";
import { AzureKeyVaultBackend } from "./azureKeyvault.js";
import { EnvSecretBackend, FileSecretBackend, MappingSecretBackend } from "./local.js";

export { SecretBackend } from "./base.js";
export { EnvSecretBackend, FileSecretBackend, MappingSecretBackend } from "./local.js";
export {
  AWSSecretsManagerBackend,
  type AwsClientOptions,
  type AwsAccessKeyOptions,
  type AwsIamRoleOptions,
  type AwsProfileOptions,
} from "./awsSecretsManager.js";
export { AzureKeyVaultBackend } from "./azureKeyvault.js";

export type SecretsProvider =
  | "aws_secrets_manager"
  | "azure_keyvault"
  | "env"
  | "file"
  | "memory"
  | "local";

const SECRETS_PROVIDERS = [
  "aws_secrets_manager",
  "azure_keyvault",
  "env",
  "file",
  "memory",
  "local",
] as const satisfies readonly SecretsProvider[];

/**
 * Factory to instantiate a secret management backend.
 *
 * Routes to the appropriate `from*` static constructor based on which
 * credential keys are present, mirroring `cloudrift-py` `get_secrets`.
 *
 * @param provider `"aws_secrets_manager"`, `"azure_keyvault"`, or a non-cloud
 *   source — `"env"` (environment variables), `"file"` (a JSON file), or
 *   `"memory"`/`"local"` (in-memory mapping, mainly dev/tests).
 * @param options  Provider-specific config.
 */
export async function getSecrets(
  provider: SecretsProvider | string,
  options: Record<string, unknown>,
): Promise<SecretBackend> {
  switch (normalizeChoice("secrets provider", provider, SECRETS_PROVIDERS)) {
    case "env":
      return new EnvSecretBackend(options as { prefix?: string });
    case "file":
      return new FileSecretBackend(options as unknown as { path: string });
    case "memory":
    case "local":
      return new MappingSecretBackend(options as { mapping?: Record<string, string> });
    case "aws_secrets_manager":
      if ("awsAccessKeyId" in options) {
        return AWSSecretsManagerBackend.fromAccessKey(options as unknown as AwsAccessKeyOptions);
      }
      if ("profileName" in options) {
        return AWSSecretsManagerBackend.fromProfile(options as unknown as AwsProfileOptions);
      }
      return AWSSecretsManagerBackend.fromIamRole(options as unknown as AwsIamRoleOptions);
    case "azure_keyvault":
      if ("clientSecret" in options) {
        return AzureKeyVaultBackend.fromServicePrincipal(
          options as unknown as {
            vaultUrl: string;
            tenantId: string;
            clientId: string;
            clientSecret: string;
          },
        );
      }
      return AzureKeyVaultBackend.fromManagedIdentity(
        options as unknown as { vaultUrl: string; clientId?: string },
      );
  }
}
