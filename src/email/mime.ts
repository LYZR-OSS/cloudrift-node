/**
 * RFC822 / MIME message assembly.
 *
 * Node has no stdlib MIME builder, so this delegates to `nodemailer` (loaded
 * lazily as an optional peer dependency) using its stream transport in
 * buffer mode — `createTransport({ streamTransport: true, buffer: true })`
 * compiles the message to a raw RFC822 buffer without opening a socket. This
 * keeps the dependency surface to the bare `nodemailer` package (no internal
 * subpath import). The structure mirrors `cloudrift-go/email/mime.go` and
 * Python's `email.message.EmailMessage`:
 *
 *   - text-only / html-only  → a single text/plain or text/html body part
 *   - text + html            → multipart/alternative
 *   - any attachments        → multipart/mixed wrapping the body part(s)
 *
 * Bcc is intentionally NOT written to the headers — Bcc recipients belong only
 * in the SMTP envelope; the caller is responsible for the envelope.
 *
 * `messageId`, when provided, is written as the `Message-ID` header.
 */

import { loadOptional } from "../core/lazy.js";
import { type Attachment, attachmentContentType } from "./base.js";

const NODEMAILER_PACKAGE = "nodemailer";

/** Shape of the lazily-imported `nodemailer` module (subset we use). */
interface NodemailerModule {
  createTransport(options: { streamTransport: true; buffer: true; newline?: string }): {
    sendMail(message: NodemailerMessage): Promise<{ message: Buffer }>;
  };
}

interface NodemailerMessage {
  from: string;
  to?: string[];
  cc?: string[];
  replyTo?: string[];
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
  headers?: Record<string, string>;
  attachments?: Array<{ filename: string; content: Uint8Array; contentType: string }>;
}

/** Fields needed to assemble a MIME message. */
export interface MimeInput {
  sender: string;
  to: string[];
  cc: string[];
  replyTo: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments: Attachment[];
  headers: Record<string, string>;
  /** Optional explicit Message-ID header. */
  messageId?: string;
}

/** Headers nodemailer manages itself — passing them through would duplicate. */
const MANAGED_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
]);

/** Build a raw RFC822 MIME message as bytes. */
export async function buildMime(input: MimeInput): Promise<Buffer> {
  const mod = await loadOptional<NodemailerModule>(NODEMAILER_PACKAGE, NODEMAILER_PACKAGE);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers)) {
    // Skip headers we manage ourselves to avoid duplicates.
    if (!MANAGED_HEADERS.has(key.toLowerCase())) {
      headers[key] = value;
    }
  }

  const message: NodemailerMessage = {
    from: input.sender,
    subject: input.subject,
  };
  if (input.to.length > 0) {
    message.to = input.to;
  }
  if (input.cc.length > 0) {
    message.cc = input.cc;
  }
  if (input.replyTo.length > 0) {
    message.replyTo = input.replyTo;
  }
  if (input.bodyText !== undefined) {
    message.text = input.bodyText;
  }
  if (input.bodyHtml !== undefined) {
    message.html = input.bodyHtml;
  }
  if (input.messageId !== undefined) {
    message.messageId = input.messageId;
  }
  if (Object.keys(headers).length > 0) {
    message.headers = headers;
  }
  if (input.attachments.length > 0) {
    message.attachments = input.attachments.map((att) => ({
      filename: att.filename,
      content: att.content,
      contentType: attachmentContentType(att),
    }));
  }

  const transport = mod.createTransport({ streamTransport: true, buffer: true, newline: "\r\n" });
  const result = await transport.sendMail(message);
  return result.message;
}
