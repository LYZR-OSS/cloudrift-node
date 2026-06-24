/**
 * Email module public surface and factory dispatch.
 *
 * `getEmail(provider, options)` dispatches on the provider string and infers
 * the auth method from which credential keys are present. Mirrors
 * `cloudrift-py`'s `cloudrift/email/__init__.py`.
 */

import { CloudRiftError } from "../core/errors.js";
import { normalizeChoice } from "../core/providers.js";
import type { EmailBackend } from "./base.js";
import { AWSSESBackend } from "./ses.js";
import { AzureACSEmailBackend } from "./azureAcs.js";
import { SMTPEmailBackend } from "./smtp.js";

export { EmailBackend } from "./base.js";
export type { Attachment, EmailMessage, SendOptions } from "./base.js";
export {
  AWSSESBackend,
  type SesClientOptions,
  type SesAccessKeyOptions,
  type SesIamRoleOptions,
  type SesProfileOptions,
} from "./ses.js";
export {
  AzureACSEmailBackend,
  type AcsConnectionStringOptions,
  type AcsManagedIdentityOptions,
  type AcsServicePrincipalOptions,
} from "./azureAcs.js";
export { SMTPEmailBackend, type SmtpBaseOptions, type SmtpAuthOptions } from "./smtp.js";

export type EmailProvider = "ses" | "azure_acs" | "smtp";

const EMAIL_PROVIDERS = ["ses", "azure_acs", "smtp"] as const satisfies readonly EmailProvider[];

/**
 * Factory to instantiate an email backend.
 *
 * Routes to the appropriate `from*` static constructor based on which
 * credential keys are present, mirroring `cloudrift-py` `get_email`.
 *
 * @param provider `"ses"`, `"azure_acs"`, or `"smtp"`.
 * @param options  Provider-specific config (camelCase keys).
 */
export async function getEmail(
  provider: EmailProvider | string,
  options: Record<string, unknown> = {},
): Promise<EmailBackend> {
  switch (normalizeChoice("email provider", provider, EMAIL_PROVIDERS)) {
    case "ses":
      if ("awsAccessKeyId" in options) {
        return AWSSESBackend.fromAccessKey(options as never);
      }
      if ("profileName" in options) {
        return AWSSESBackend.fromProfile(options as never);
      }
      return AWSSESBackend.fromIamRole(options as never);
    case "azure_acs":
      if ("connectionString" in options) {
        return AzureACSEmailBackend.fromConnectionString(options as never);
      }
      if ("clientSecret" in options) {
        return AzureACSEmailBackend.fromServicePrincipal(options as never);
      }
      return AzureACSEmailBackend.fromManagedIdentity(options as never);
    case "smtp": {
      const mode = typeof options.mode === "string" ? options.mode : "starttls";
      switch (mode) {
        case "tls":
          return SMTPEmailBackend.fromTls(options as never);
        case "plaintext":
          return SMTPEmailBackend.fromPlaintext(options as never);
        case "starttls":
          return SMTPEmailBackend.fromStarttls(options as never);
        default:
          throw new CloudRiftError(
            `Unknown SMTP mode: ${JSON.stringify(mode)}. Choose 'plaintext', 'starttls', or 'tls'.`,
          );
      }
    }
  }
}
