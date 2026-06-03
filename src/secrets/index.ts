import { CloudRiftError } from "../core/errors.js";
import { SecretBackend } from "./base.js";
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
  provider: SecretsProvider,
  options: Record<string, unknown>,
): Promise<SecretBackend> {
  if (provider === "aws_secrets_manager") {
    if ("awsAccessKeyId" in options) {
      return AWSSecretsManagerBackend.fromAccessKey(
        options as unknown as AwsAccessKeyOptions,
      );
    }
    if ("profileName" in options) {
      return AWSSecretsManagerBackend.fromProfile(
        options as unknown as AwsProfileOptions,
      );
    }
    return AWSSecretsManagerBackend.fromIamRole(
      options as unknown as AwsIamRoleOptions,
    );
  }

  if (provider === "azure_keyvault") {
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

  throw new CloudRiftError(
    `Unknown secrets provider: ${String(provider)}. ` +
      "Choose 'aws_secrets_manager' or 'azure_keyvault'.",
  );
}
