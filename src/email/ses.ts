/**
 * AWS SES email backend (SESv2 via `@aws-sdk/client-sesv2`).
 *
 * A single SESv2 client is created lazily on first use (promise-memoized) and
 * reused for the lifetime of the backend. Mirrors `cloudrift-py`'s
 * `cloudrift/email/ses.py`.
 */

import type { SESv2Client, SESv2ClientConfig } from "@aws-sdk/client-sesv2";

import {
  EmailError,
  EmailSendError,
  EmailThrottledError,
  RecipientRejectedError,
  SenderUnverifiedError,
} from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { EmailBackend, asList, type SendOptions } from "./base.js";
import { buildMime } from "./mime.js";

const SES_PACKAGE = "@aws-sdk/client-sesv2";
const PROVIDER = "ses";
const DEFAULT_REGION = "us-east-1";

// Match Python ses.py botocore Config defaults.
const DEFAULT_MAX_POOL_CONNECTIONS = 25;
const DEFAULT_CONNECT_TIMEOUT = 10; // seconds
const DEFAULT_READ_TIMEOUT = 30; // seconds

/** Shape of the lazily-imported `@aws-sdk/client-sesv2` module. */
interface SesModule {
  SESv2Client: new (config: SESv2ClientConfig) => SESv2Client;
  SendEmailCommand: new (input: Record<string, unknown>) => object;
  ListEmailIdentitiesCommand: new (input: Record<string, unknown>) => object;
}

/** Options shared across all SES factory constructors. */
export interface SesClientOptions {
  defaultFrom?: string;
  region?: string;
  endpointUrl?: string;
  maxPoolConnections?: number;
  connectTimeout?: number;
  readTimeout?: number;
}

export interface SesAccessKeyOptions extends SesClientOptions {
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken?: string;
}

export type SesIamRoleOptions = SesClientOptions;

export interface SesProfileOptions extends SesClientOptions {
  profileName: string;
}

interface SesConfig {
  defaultFrom?: string;
  region: string;
  endpointUrl?: string;
  maxPoolConnections: number;
  connectTimeout: number;
  readTimeout: number;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  profile?: string;
}

function buildConfig(
  opts: SesClientOptions,
): Pick<
  SesConfig,
  "defaultFrom" | "region" | "endpointUrl" | "maxPoolConnections" | "connectTimeout" | "readTimeout"
> {
  return {
    defaultFrom: opts.defaultFrom,
    region: opts.region ?? DEFAULT_REGION,
    endpointUrl: opts.endpointUrl,
    maxPoolConnections: opts.maxPoolConnections ?? DEFAULT_MAX_POOL_CONNECTIONS,
    connectTimeout: opts.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT,
    readTimeout: opts.readTimeout ?? DEFAULT_READ_TIMEOUT,
  };
}

export class AWSSESBackend extends EmailBackend {
  private readonly config: SesConfig;
  private mod: SesModule | undefined;
  private client: SESv2Client | undefined;
  private ensuring: Promise<SESv2Client> | undefined;

  private constructor(config: SesConfig) {
    super();
    this.config = config;
  }

  // ------------------------------------------------------------------
  // Factory constructors
  // ------------------------------------------------------------------

  /** Authenticate with explicit access key / secret (+ optional STS session token). */
  static fromAccessKey(opts: SesAccessKeyOptions): AWSSESBackend {
    return new AWSSESBackend({
      ...buildConfig(opts),
      credentials: {
        accessKeyId: opts.awsAccessKeyId,
        secretAccessKey: opts.awsSecretAccessKey,
        sessionToken: opts.awsSessionToken,
      },
    });
  }

  /** Authenticate via IAM role / instance profile / environment variables. */
  static fromIamRole(opts: SesIamRoleOptions = {}): AWSSESBackend {
    return new AWSSESBackend(buildConfig(opts));
  }

  /** Authenticate using a named profile from `~/.aws/credentials`. */
  static fromProfile(opts: SesProfileOptions): AWSSESBackend {
    return new AWSSESBackend({
      ...buildConfig(opts),
      profile: opts.profileName,
    });
  }

  // ------------------------------------------------------------------
  // Internal lifecycle (lazy, promise-memoized client init)
  // ------------------------------------------------------------------

  private async ensure(): Promise<SESv2Client> {
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
      this.mod = undefined;
      throw err;
    }
  }

  private async createClient(): Promise<SESv2Client> {
    const mod = await loadOptional<SesModule>(SES_PACKAGE, PROVIDER);
    this.mod = mod;
    const cfg: SESv2ClientConfig = {
      region: this.config.region,
      requestHandler: {
        connectionTimeout: this.config.connectTimeout * 1000,
        requestTimeout: this.config.readTimeout * 1000,
        httpsAgent: { maxSockets: this.config.maxPoolConnections, keepAlive: true },
      } as unknown as SESv2ClientConfig["requestHandler"],
    };
    if (this.config.endpointUrl !== undefined) {
      cfg.endpoint = this.config.endpointUrl;
    }
    if (this.config.credentials !== undefined) {
      cfg.credentials = {
        accessKeyId: this.config.credentials.accessKeyId,
        secretAccessKey: this.config.credentials.secretAccessKey,
        sessionToken: this.config.credentials.sessionToken,
      };
    } else if (this.config.profile !== undefined) {
      const credsMod = await loadOptional<typeof import("@aws-sdk/credential-providers")>(
        "@aws-sdk/credential-providers",
        PROVIDER,
      );
      cfg.credentials = credsMod.fromIni({ profile: this.config.profile });
    }
    return new mod.SESv2Client(cfg);
  }

  override async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.ensuring = undefined;
    if (client !== undefined) {
      client.destroy();
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

    const toList = asList(to);
    const ccList = asList(options.cc);
    const bccList = asList(options.bcc);
    const replyTo = asList(options.replyTo);
    const attachments = options.attachments ?? [];
    const headers = options.headers ?? {};

    const client = await this.ensure();
    const mod = this.mod!;

    let content: Record<string, unknown>;
    if (attachments.length > 0 || Object.keys(headers).length > 0) {
      const raw = await buildMime({
        sender,
        to: toList,
        cc: ccList,
        replyTo,
        subject,
        bodyText: options.bodyText,
        bodyHtml: options.bodyHtml,
        attachments,
        headers,
      });
      content = { Raw: { Data: raw } };
    } else {
      const body: Record<string, unknown> = {};
      if (options.bodyText !== undefined) {
        body.Text = { Data: options.bodyText, Charset: "UTF-8" };
      }
      if (options.bodyHtml !== undefined) {
        body.Html = { Data: options.bodyHtml, Charset: "UTF-8" };
      }
      content = {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: body,
        },
      };
    }

    try {
      const response = (await client.send(
        new mod.SendEmailCommand({
          FromEmailAddress: sender,
          Destination: {
            ToAddresses: toList,
            CcAddresses: ccList,
            BccAddresses: bccList,
          },
          Content: content,
          ReplyToAddresses: replyTo,
        }) as never,
      )) as { MessageId?: string };
      if (response.MessageId === undefined) {
        // Python reads response["MessageId"] and raises KeyError when absent;
        // surface it as EmailSendError rather than returning an empty id.
        throw new EmailSendError("SES SendEmail response is missing MessageId.");
      }
      return response.MessageId;
    } catch (err) {
      throw mapSesError(err);
    }
  }

  override async healthCheck(): Promise<boolean> {
    try {
      const client = await this.ensure();
      const mod = this.mod!;
      await client.send(new mod.ListEmailIdentitiesCommand({}) as never);
      return true;
    } catch {
      return false;
    }
  }
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const name = (err as { name?: unknown }).name;
  if (typeof name === "string") {
    return name;
  }
  const upper = (err as { Code?: unknown }).Code;
  if (typeof upper === "string") {
    return upper;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** Translate an SES SDK error into the cloudrift email error tree. */
function mapSesError(err: unknown): Error {
  if (err instanceof EmailError) {
    return err;
  }
  const code = errorCode(err);
  if (code === "MessageRejected") {
    return new RecipientRejectedError(errorMessage(err), { cause: err });
  }
  if (
    code === "MailFromDomainNotVerified" ||
    code === "MailFromDomainNotVerifiedException" ||
    code === "FromEmailAddressNotVerified"
  ) {
    return new SenderUnverifiedError(errorMessage(err), { cause: err });
  }
  if (
    code === "Throttling" ||
    code === "TooManyRequestsException" ||
    code === "SendingPausedException"
  ) {
    return new EmailThrottledError(errorMessage(err), { cause: err });
  }
  return new EmailSendError(errorMessage(err), { cause: err });
}
