/**
 * Azure Communication Services (ACS) email backend
 * (`@azure/communication-email`).
 *
 * A single `EmailClient` (and its credential, for token auth) is created lazily
 * on first use behind a memoized promise. Mirrors `cloudrift-py`'s
 * `cloudrift/email/azure_acs.py`.
 */

import type { TokenCredential } from "@azure/core-auth";
import type { EmailClient, EmailMessage as AcsEmailMessage } from "@azure/communication-email";

import {
  EmailError,
  EmailSendError,
  EmailThrottledError,
  RecipientRejectedError,
  SenderUnverifiedError,
} from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { EmailBackend, asList, attachmentContentType, type SendOptions } from "./base.js";

const ACS_PACKAGE = "@azure/communication-email";
const IDENTITY_PACKAGE = "@azure/identity";
const PROVIDER = "azure_acs";

interface AcsSdk {
  EmailClient: {
    new (connectionString: string): EmailClient;
    new (endpoint: string, credential: TokenCredential): EmailClient;
  };
}

interface IdentitySdk {
  ManagedIdentityCredential: typeof import("@azure/identity").ManagedIdentityCredential;
  ClientSecretCredential: typeof import("@azure/identity").ClientSecretCredential;
}

type CredentialFactory = (identity: IdentitySdk) => TokenCredential;

interface AcsConfig {
  defaultFrom?: string;
  connectionString?: string;
  endpoint?: string;
  credentialFactory?: CredentialFactory;
}

export interface AcsConnectionStringOptions {
  connectionString: string;
  defaultFrom?: string;
}

export interface AcsManagedIdentityOptions {
  endpoint: string;
  defaultFrom?: string;
  clientId?: string;
}

export interface AcsServicePrincipalOptions {
  endpoint: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  defaultFrom?: string;
}

export class AzureACSEmailBackend extends EmailBackend {
  private readonly config: AcsConfig;
  private client: EmailClient | undefined;
  private credential: TokenCredential | undefined;
  private ensuring: Promise<EmailClient> | undefined;

  private constructor(config: AcsConfig) {
    super();
    this.config = config;
  }

  // ------------------------------------------------------------------
  // Factory constructors
  // ------------------------------------------------------------------

  /** Authenticate with an ACS connection string. */
  static fromConnectionString(opts: AcsConnectionStringOptions): AzureACSEmailBackend {
    return new AzureACSEmailBackend({
      defaultFrom: opts.defaultFrom,
      connectionString: opts.connectionString,
    });
  }

  /** Authenticate via Azure Managed Identity (system- or user-assigned). */
  static fromManagedIdentity(opts: AcsManagedIdentityOptions): AzureACSEmailBackend {
    return new AzureACSEmailBackend({
      defaultFrom: opts.defaultFrom,
      endpoint: opts.endpoint,
      credentialFactory: (identity) =>
        opts.clientId
          ? new identity.ManagedIdentityCredential({ clientId: opts.clientId })
          : new identity.ManagedIdentityCredential(),
    });
  }

  /** Authenticate via Azure AD service principal (client secret). */
  static fromServicePrincipal(opts: AcsServicePrincipalOptions): AzureACSEmailBackend {
    return new AzureACSEmailBackend({
      defaultFrom: opts.defaultFrom,
      endpoint: opts.endpoint,
      credentialFactory: (identity) =>
        new identity.ClientSecretCredential(opts.tenantId, opts.clientId, opts.clientSecret),
    });
  }

  // ------------------------------------------------------------------
  // Internal lifecycle
  // ------------------------------------------------------------------

  private async ensure(): Promise<EmailClient> {
    if (this.client !== undefined) {
      return this.client;
    }
    if (this.ensuring === undefined) {
      this.ensuring = this.createClient();
    }
    try {
      this.client = await this.ensuring;
      return this.client;
    } catch (err) {
      this.ensuring = undefined;
      this.credential = undefined;
      throw err;
    }
  }

  private async createClient(): Promise<EmailClient> {
    const acs = await loadOptional<AcsSdk>(ACS_PACKAGE, PROVIDER);
    if (this.config.connectionString !== undefined) {
      return new acs.EmailClient(this.config.connectionString);
    }
    const identity = await loadOptional<IdentitySdk>(IDENTITY_PACKAGE, PROVIDER);
    const credential = this.config.credentialFactory!(identity);
    this.credential = credential;
    return new acs.EmailClient(this.config.endpoint!, credential);
  }

  override async close(): Promise<void> {
    const credential = this.credential as
      | (TokenCredential & { close?: () => Promise<void> })
      | undefined;
    this.client = undefined;
    this.credential = undefined;
    this.ensuring = undefined;
    if (credential && typeof credential.close === "function") {
      await credential.close();
    }
  }

  // ------------------------------------------------------------------
  // EmailBackend implementation
  // ------------------------------------------------------------------

  override async send(
    to: string | string[],
    subject: string,
    options: SendOptions = {},
  ): Promise<string> {
    const sender = options.from ?? this.config.defaultFrom;
    if (!sender) {
      throw new EmailError("No sender address: pass from or set defaultFrom on the backend.");
    }
    if (options.bodyText === undefined && options.bodyHtml === undefined) {
      throw new EmailError("send() requires bodyText and/or bodyHtml.");
    }

    const client = await this.ensure();

    const content: Record<string, unknown> = { subject };
    if (options.bodyText !== undefined) {
      content.plainText = options.bodyText;
    }
    if (options.bodyHtml !== undefined) {
      content.html = options.bodyHtml;
    }

    const recipients: Record<string, unknown> = {
      to: asList(to).map((address) => ({ address })),
    };
    const ccList = asList(options.cc);
    if (ccList.length > 0) {
      recipients.cc = ccList.map((address) => ({ address }));
    }
    const bccList = asList(options.bcc);
    if (bccList.length > 0) {
      recipients.bcc = bccList.map((address) => ({ address }));
    }

    const message: Record<string, unknown> = {
      senderAddress: sender,
      recipients,
      content,
    };
    const replyTo = asList(options.replyTo);
    if (replyTo.length > 0) {
      message.replyTo = replyTo.map((address) => ({ address }));
    }
    if (options.attachments && options.attachments.length > 0) {
      message.attachments = options.attachments.map((att) => ({
        name: att.filename,
        contentType: attachmentContentType(att),
        contentInBase64: Buffer.from(att.content).toString("base64"),
      }));
    }
    if (options.headers && Object.keys(options.headers).length > 0) {
      message.headers = { ...options.headers };
    }

    try {
      const poller = await client.beginSend(message as unknown as AcsEmailMessage);
      const result = (await poller.pollUntilDone()) as { id?: string; messageId?: string };
      return result.id ?? result.messageId ?? "";
    } catch (err) {
      throw mapAcsError(err);
    }
  }
}

function statusCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const e = err as { statusCode?: unknown; code?: unknown };
  if (typeof e.statusCode === "number") {
    return e.statusCode;
  }
  if (typeof e.code === "number") {
    return e.code;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** Translate an ACS SDK error into the cloudrift email error tree. */
function mapAcsError(err: unknown): Error {
  if (err instanceof EmailError) {
    return err;
  }
  const status = statusCode(err);
  const message = errorMessage(err);
  if (status === 429) {
    return new EmailThrottledError(message, { cause: err });
  }
  if (status === 403 && message.includes("DomainNotLinked")) {
    return new SenderUnverifiedError(message, { cause: err });
  }
  if (
    status === 400 &&
    (message.includes("InvalidRecipient") || message.includes("InvalidAddress"))
  ) {
    return new RecipientRejectedError(message, { cause: err });
  }
  return new EmailSendError(message, { cause: err });
}
