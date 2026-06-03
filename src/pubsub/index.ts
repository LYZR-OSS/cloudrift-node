/**
 * Pub/Sub module public surface.
 *
 * `getPubsub(provider, options)` dispatches on the provider string and infers
 * the auth method from which credential keys are present. Mirrors
 * `cloudrift-py`'s `cloudrift/pubsub/__init__.py`.
 */

import { normalizeChoice } from "../core/providers.js";
import type { PubSubBackend } from "./base.js";
import { AWSSNSBackend } from "./sns.js";
import { AzureEventGridBackend } from "./azureEventgrid.js";

export { PubSubBackend, type PubSubMessage } from "./base.js";
export { AWSSNSBackend } from "./sns.js";
export { AzureEventGridBackend } from "./azureEventgrid.js";

export type PubSubProvider = "sns" | "azure_eventgrid";

const PUBSUB_PROVIDERS = ["sns", "azure_eventgrid"] as const satisfies readonly PubSubProvider[];

export async function getPubsub(
  provider: PubSubProvider | string,
  options: Record<string, unknown>,
): Promise<PubSubBackend> {
  switch (normalizeChoice("pubsub provider", provider, PUBSUB_PROVIDERS)) {
    case "sns":
      if ("awsAccessKeyId" in options) {
        return AWSSNSBackend.fromAccessKey(options as never);
      }
      if ("profileName" in options) {
        return AWSSNSBackend.fromProfile(options as never);
      }
      return AWSSNSBackend.fromIamRole(options as never);
    case "azure_eventgrid":
      if ("accessKey" in options) {
        return AzureEventGridBackend.fromAccessKey(options as never);
      }
      if ("clientSecret" in options) {
        return AzureEventGridBackend.fromServicePrincipal(options as never);
      }
      return AzureEventGridBackend.fromManagedIdentity(options as never);
  }
}
