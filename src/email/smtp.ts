/**
 * Raw SMTP email backend (SendGrid, Mailgun, Postmark, Office365, MailHog, …)
 * via `nodemailer`.
 *
 * A fresh transport is opened per {@link send}. SMTP servers commonly drop idle
 * connections and the simplicity is worth more than the marginal latency win —
 * transactional volumes don't benefit from pooling. Mirrors `cloudrift-py`'s
 * `cloudrift/email/smtp.py`.
 */

import { randomBytes } from "node:crypto";

import {
  EmailError,
  EmailSendError,
  EmailThrottledError,
  RecipientRejectedError,
  SenderUnverifiedError,
} from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { EmailBackend, asList, attachmentContentType, type SendOptions } from "./base.js";

const NODEMAILER_PACKAGE = "nodemailer";
const PROVIDER = "smtp";

const MODE_PLAINTEXT = "plaintext";
const MODE_STARTTLS = "starttls";
const MODE_TLS = "tls";

type SmtpMode = typeof MODE_PLAINTEXT | typeof MODE_STARTTLS | typeof MODE_TLS;

/** Shape of the lazily-imported `nodemailer` module (subset we use). */
interface NodemailerModule {
  createTransport(options: TransportOptions): Transporter;
}

interface TransportOptions {
  host: string;
  port: number;
  secure: boolean;
  ignoreTLS?: boolean;
  requireTLS?: boolean;
  auth?: { user: string; pass: string };
  connectionTimeout?: number;
  greetingTimeout?: number;
  socketTimeout?: number;
}

interface Transporter {
  sendMail(message: NodemailerMessage): Promise<{ messageId?: string }>;
  verify(): Promise<true>;
  close(): void;
}

interface NodemailerMessage {
  from: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  text?: string;
  html?: string;
  messageId: string;
  headers?: Record<string, string>;
  attachments?: Array<{ filename: string; content: Uint8Array; contentType: string }>;
}

export interface SmtpBaseOptions {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  defaultFrom?: string;
  /** Connection timeout in seconds (default 30). */
  timeout?: number;
}

export interface SmtpAuthOptions extends SmtpBaseOptions {
  username: string;
  password: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  mode: SmtpMode;
  username?: string;
  password?: string;
  defaultFrom?: string;
  timeout: number;
}

const DEFAULT_TIMEOUT = 30; // seconds

export class SMTPEmailBackend extends EmailBackend {
  private readonly config: SmtpConfig;

  private constructor(config: SmtpConfig) {
    super();
    this.config = config;
  }

  // ------------------------------------------------------------------
  // Factory constructors
  // ------------------------------------------------------------------

  /** Connect without TLS (port 25). Dev / local-relay only. */
  static fromPlaintext(opts: SmtpBaseOptions): SMTPEmailBackend {
    requireHost(opts.host);
    return new SMTPEmailBackend({
      host: opts.host,
      port: opts.port ?? 25,
      mode: MODE_PLAINTEXT,
      username: opts.username,
      password: opts.password,
      defaultFrom: opts.defaultFrom,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    });
  }

  /** Connect, then upgrade to TLS via STARTTLS (port 587). Default for most providers. */
  static fromStarttls(opts: SmtpAuthOptions): SMTPEmailBackend {
    requireHost(opts.host);
    requireCredentials(MODE_STARTTLS, opts.username, opts.password);
    return new SMTPEmailBackend({
      host: opts.host,
      port: opts.port ?? 587,
      mode: MODE_STARTTLS,
      username: opts.username,
      password: opts.password,
      defaultFrom: opts.defaultFrom,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    });
  }

  /** Connect with implicit TLS (port 465). */
  static fromTls(opts: SmtpAuthOptions): SMTPEmailBackend {
    requireHost(opts.host);
    requireCredentials(MODE_TLS, opts.username, opts.password);
    return new SMTPEmailBackend({
      host: opts.host,
      port: opts.port ?? 465,
      mode: MODE_TLS,
      username: opts.username,
      password: opts.password,
      defaultFrom: opts.defaultFrom,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    });
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
    const messageId = newMessageId(sender);

    const message: NodemailerMessage = {
      from: sender,
      subject,
      messageId,
    };
    if (toList.length > 0) {
      message.to = toList;
    }
    if (ccList.length > 0) {
      message.cc = ccList;
    }
    if (bccList.length > 0) {
      message.bcc = bccList;
    }
    if (replyTo.length > 0) {
      message.replyTo = replyTo;
    }
    if (options.bodyText !== undefined) {
      message.text = options.bodyText;
    }
    if (options.bodyHtml !== undefined) {
      message.html = options.bodyHtml;
    }
    if (options.headers && Object.keys(options.headers).length > 0) {
      message.headers = options.headers;
    }
    if (options.attachments && options.attachments.length > 0) {
      message.attachments = options.attachments.map((att) => ({
        filename: att.filename,
        content: att.content,
        contentType: attachmentContentType(att),
      }));
    }

    const transporter = await this.createTransport();
    try {
      const result = await transporter.sendMail(message);
      return result.messageId ?? messageId;
    } catch (err) {
      throw mapSmtpError(err);
    } finally {
      transporter.close();
    }
  }

  override async healthCheck(): Promise<boolean> {
    let transporter: Transporter | undefined;
    try {
      transporter = await this.createTransport();
      await transporter.verify();
      return true;
    } catch {
      return false;
    } finally {
      transporter?.close();
    }
  }

  private async createTransport(): Promise<Transporter> {
    const mod = await loadOptional<NodemailerModule>(NODEMAILER_PACKAGE, PROVIDER);
    const timeoutMs = this.config.timeout * 1000;
    const opts: TransportOptions = {
      host: this.config.host,
      port: this.config.port,
      secure: this.config.mode === MODE_TLS,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    };
    if (this.config.mode === MODE_STARTTLS) {
      opts.requireTLS = true;
    } else if (this.config.mode === MODE_PLAINTEXT) {
      opts.ignoreTLS = true;
    }
    if (this.config.username && this.config.password) {
      opts.auth = { user: this.config.username, pass: this.config.password };
    }
    return mod.createTransport(opts);
  }
}

/**
 * Fail loud when the SMTP host is empty, mirroring Python/Go ("SMTP host is
 * required"). Passing `getEmail("smtp", {})` otherwise silently builds a
 * backend that only fails much later at connect time.
 */
function requireHost(host: unknown): void {
  if (typeof host !== "string" || host.trim() === "") {
    throw new EmailError("SMTP host is required.");
  }
}

/** STARTTLS/TLS authenticate before sending; require username and password. */
function requireCredentials(mode: SmtpMode, username: unknown, password: unknown): void {
  const missingUser = typeof username !== "string" || username === "";
  const missingPass = typeof password !== "string" || password === "";
  if (missingUser || missingPass) {
    throw new EmailError(`SMTP ${mode} mode requires both username and password.`);
  }
}

/** Generate an RFC 5322 Message-ID using the sender's domain. */
function newMessageId(sender: string): string {
  let domain = "localhost";
  const at = sender.lastIndexOf("@");
  if (at >= 0 && at < sender.length - 1) {
    domain = sender.slice(at + 1).replace(/[<> ]/g, "");
    if (domain.length === 0) {
      domain = "localhost";
    }
  }
  return `<${randomBytes(16).toString("hex")}@${domain}>`;
}

/** SMTP reply code, if the error exposes one (nodemailer surfaces `responseCode`). */
function responseCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const e = err as { responseCode?: unknown; code?: unknown };
  if (typeof e.responseCode === "number") {
    return e.responseCode;
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

/** Translate an SMTP error into the cloudrift email error tree. */
function mapSmtpError(err: unknown): Error {
  if (err instanceof EmailError) {
    return err;
  }
  const code = responseCode(err);
  if (code === 421 || code === 450 || code === 451 || code === 452) {
    return new EmailThrottledError(errorMessage(err), { cause: err });
  }
  // nodemailer flags refused recipients / senders via err.code === "EENVELOPE".
  // A MAIL-FROM rejection (SMTPSenderRefused, 550/551/553) carries no rejected[]
  // recipients; mirror Python's type-based SMTPSenderRefused -> SenderUnverifiedError
  // (cloudrift-py/cloudrift/email/smtp.py:186-187). This must be checked BEFORE the
  // 55x recipient branch, since envelope errors also surface those reply codes.
  const errCode =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (errCode === "EENVELOPE") {
    const rejected = (err as { rejected?: unknown }).rejected;
    if (Array.isArray(rejected) && rejected.length > 0) {
      return new RecipientRejectedError(errorMessage(err), { cause: err });
    }
    return new SenderUnverifiedError(errorMessage(err), { cause: err });
  }
  if (code === 550 || code === 551 || code === 553) {
    return new RecipientRejectedError(errorMessage(err), { cause: err });
  }
  return new EmailSendError(errorMessage(err), { cause: err });
}
