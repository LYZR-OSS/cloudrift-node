import { normalizeChoice } from "../core/providers.js";
import type { SecretBackend } from "./base.js";
import {
  AWSSecretsManagerBackend,
  type AwsAccessKeyOptions,
  type AwsIamRoleOptions,
  type AwsProfileOptions,
} from "./awsSecretsManager.js";
import { AzureKeyVaultBackend } from "./azureKeyvault.js";

export { SecretBackend } from "./base.js";
export {
  AWSSecretsManagerBackend,
  type AwsClientOptions,
  type AwsAccessKeyOptions,
  type AwsIamRoleOptions,
  type AwsProfileOptions,
} from "./awsSecretsManager.js";
export { AzureKeyVaultBackend } from "./azureKeyvault.js";

export type SecretsProvider = "aws_secrets_manager" | "azure_keyvault";

const SECRETS_PROVIDERS = [
  "aws_secrets_manager",
  "azure_keyvault",
] as const satisfies readonly SecretsProvider[];

/**
 * Factory to instantiate a secret management backend.
 *
 * Routes to the appropriate `from*` static constructor based on which
 * credential keys are present, mirroring `cloudrift-py` `get_secrets`.
 *
 * @param provider `"aws_secrets_manager"` or `"azure_keyvault"`.
 * @param options  Provider-specific config.
 */
export async function getSecrets(
  provider: SecretsProvider | string,
  options: Record<string, unknown>,
): Promise<SecretBackend> {
  switch (normalizeChoice("secrets provider", provider, SECRETS_PROVIDERS)) {
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
