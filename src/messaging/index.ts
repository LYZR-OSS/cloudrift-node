import { CloudRiftError } from "../core/errors.js";
import type { MessagingBackend } from "./base.js";
import {
  AWSSQSBackend,
  type SqsAccessKeyOptions,
  type SqsIamRoleOptions,
  type SqsProfileOptions,
} from "./sqs.js";
import {
  AzureServiceBusBackend,
  type AzureBusConnectionStringOptions,
  type AzureBusManagedIdentityOptions,
  type AzureBusServicePrincipalOptions,
} from "./azureBus.js";

export { type Message, MessagingBackend } from "./base.js";
export { AWSSQSBackend } from "./sqs.js";
export { AzureServiceBusBackend } from "./azureBus.js";

export type QueueProvider = "sqs" | "azure_service_bus";

/**
 * Factory to instantiate a messaging backend.
 *
 * Routes to the appropriate `from*` static constructor based on which
 * credential keys are present in `options` (mirrors `get_queue` in
 * `cloudrift-py`). Construction is synchronous; the underlying SDK client is
 * created lazily on first operation, so this returns a resolved promise.
 *
 * @param provider `"sqs"` or `"azure_service_bus"`.
 * @param options  Provider-specific config (camelCase keys).
 */
export function getQueue(
  provider: QueueProvider,
  options: Record<string, unknown>,
): Promise<MessagingBackend> {
  if (provider === "sqs") {
    if ("awsAccessKeyId" in options) {
      return Promise.resolve(
        AWSSQSBackend.fromAccessKey(options as unknown as SqsAccessKeyOptions),
      );
    }
    if ("profileName" in options) {
      return Promise.resolve(AWSSQSBackend.fromProfile(options as unknown as SqsProfileOptions));
    }
    return Promise.resolve(AWSSQSBackend.fromIamRole(options as unknown as SqsIamRoleOptions));
  }

  if (provider === "azure_service_bus") {
    if ("connectionString" in options) {
      return Promise.resolve(
        AzureServiceBusBackend.fromConnectionString(
          options as unknown as AzureBusConnectionStringOptions,
        ),
      );
    }
    if ("clientSecret" in options) {
      return Promise.resolve(
        AzureServiceBusBackend.fromServicePrincipal(
          options as unknown as AzureBusServicePrincipalOptions,
        ),
      );
    }
    return Promise.resolve(
      AzureServiceBusBackend.fromManagedIdentity(
        options as unknown as AzureBusManagedIdentityOptions,
      ),
    );
  }

  throw new CloudRiftError(
    `Unknown messaging provider: ${JSON.stringify(provider)}. ` +
      "Choose 'sqs' or 'azure_service_bus'.",
  );
}
