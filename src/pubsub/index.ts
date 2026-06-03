/**
 * Pub/Sub module public surface.
 *
 * `getPubsub(provider, options)` dispatches on the provider string and infers
 * the auth method from which credential keys are present. Mirrors
 * `cloudrift-py`'s `cloudrift/pubsub/__init__.py`.
 */

import { CloudRiftError } from "../core/errors.js";
import type { PubSubBackend } from "./base.js";
import { AWSSNSBackend } from "./sns.js";
import { AzureEventGridBackend } from "./azureEventgrid.js";

export { PubSubBackend, type PubSubMessage } from "./base.js";
export { AWSSNSBackend } from "./sns.js";
export { AzureEventGridBackend } from "./azureEventgrid.js";

export type PubSubProvider = "sns" | "azure_eventgrid";

export async function getPubsub(
  provider: PubSubProvider,
  options: Record<string, unknown>,
): Promise<PubSubBackend> {
  if (provider === "sns") {
    if ("awsAccessKeyId" in options) {
      return AWSSNSBackend.fromAccessKey(options as never);
    }
    if ("profileName" in options) {
      return AWSSNSBackend.fromProfile(options as never);
    }
    return AWSSNSBackend.fromIamRole(options as never);
  }

  if (provider === "azure_eventgrid") {
    if ("accessKey" in options) {
      return AzureEventGridBackend.fromAccessKey(options as never);
    }
    if ("clientSecret" in options) {
      return AzureEventGridBackend.fromServicePrincipal(options as never);
    }
    return AzureEventGridBackend.fromManagedIdentity(options as never);
  }

  throw new CloudRiftError(
    `Unknown pubsub provider: ${JSON.stringify(provider)}. Choose 'sns' or 'azure_eventgrid'.`,
  );
}
