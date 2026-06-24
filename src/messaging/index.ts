import { normalizeChoice } from "../core/providers.js";
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

export {
  type Message,
  type SendOptions,
  type SendBatchOptions,
  type ReceiveOptions,
  MessagingBackend,
} from "./base.js";
export {
  AWSSQSBackend,
  type SqsAccessKeyOptions,
  type SqsIamRoleOptions,
  type SqsProfileOptions,
} from "./sqs.js";
export {
  AzureServiceBusBackend,
  type AzureBusConnectionStringOptions,
  type AzureBusManagedIdentityOptions,
  type AzureBusServicePrincipalOptions,
} from "./azureBus.js";

export type QueueProvider = "sqs" | "azure_service_bus";

const QUEUE_PROVIDERS = ["sqs", "azure_service_bus"] as const satisfies readonly QueueProvider[];

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
  provider: QueueProvider | string,
  options: Record<string, unknown>,
): Promise<MessagingBackend> {
  const normalizedProvider = normalizeChoice("messaging provider", provider, QUEUE_PROVIDERS, {
    azure_bus: "azure_service_bus",
  });

  switch (normalizedProvider) {
    case "sqs":
      if ("awsAccessKeyId" in options) {
        return Promise.resolve(
          AWSSQSBackend.fromAccessKey(options as unknown as SqsAccessKeyOptions),
        );
      }
      if ("profileName" in options) {
        return Promise.resolve(AWSSQSBackend.fromProfile(options as unknown as SqsProfileOptions));
      }
      return Promise.resolve(AWSSQSBackend.fromIamRole(options as unknown as SqsIamRoleOptions));
    case "azure_service_bus":
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
}
