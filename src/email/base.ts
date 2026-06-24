/**
 * Email module provider-neutral interface.
 *
 * Mirrors `cloudrift-py`'s `cloudrift/email/base.py`: an abstract
 * `EmailBackend` plus the `EmailMessage` / `Attachment` value types. Backends
 * hold long-lived clients — construct once at service startup and reuse, then
 * release sockets with `await backend.close()` (or `await using`).
 */

/** An email attachment.
 *
 * `content` is the raw payload bytes. `contentType` is used directly in the
 * MIME / provider request — pick the right one (`application/pdf`,
 * `image/png`, …) so the recipient's mail client renders it correctly.
 */
export interface Attachment {
  filename: string;
  content: Uint8Array;
  /** Defaults to `"application/octet-stream"` when omitted. */
  contentType?: string;
}

/**
 * An outbound email used by {@link EmailBackend.sendBatch}.
 *
 * `from` falls back to the backend's `defaultFrom` when omitted. At least one
 * of `bodyText` / `bodyHtml` must be set.
 */
export interface EmailMessage {
  to: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  from?: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  attachments?: Attachment[];
  headers?: Record<string, string>;
}

/** Options accepted by {@link EmailBackend.send}. */
export interface SendOptions {
  bodyText?: string;
  bodyHtml?: string;
  from?: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  attachments?: Attachment[];
  headers?: Record<string, string>;
}

/**
 * Abstract base class for transactional email backends.
 *
 * Implementations accept a `defaultFrom` at construction time; the `from`
 * option on {@link send} overrides it per call.
 */
export abstract class EmailBackend {
  /** Send a single email. Returns the provider message ID. */
  abstract send(to: string | string[], subject: string, options?: SendOptions): Promise<string>;

  /**
   * Send a batch of emails. Default implementation loops {@link send}.
   *
   * Subclasses override only when the provider has a true bulk API.
   */
  async sendBatch(messages: EmailMessage[]): Promise<string[]> {
    const ids: string[] = [];
    for (const msg of messages) {
      ids.push(
        await this.send(msg.to, msg.subject, {
          bodyText: msg.bodyText,
          bodyHtml: msg.bodyHtml,
          from: msg.from,
          cc: msg.cc && msg.cc.length > 0 ? msg.cc : undefined,
          bcc: msg.bcc && msg.bcc.length > 0 ? msg.bcc : undefined,
          replyTo: msg.replyTo && msg.replyTo.length > 0 ? msg.replyTo : undefined,
          attachments: msg.attachments && msg.attachments.length > 0 ? msg.attachments : undefined,
          headers: msg.headers && Object.keys(msg.headers).length > 0 ? msg.headers : undefined,
        }),
      );
    }
    return ids;
  }

  /** Return true if the email backend is reachable. Default is `true`. */
  async healthCheck(): Promise<boolean> {
    return true;
  }

  /** Close the underlying client and release sockets. Default is a no-op. */
  async close(): Promise<void> {
    /* no-op by default */
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Normalize a recipient / address field to an array. */
export function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  return [...value];
}

/** An attachment's effective content type (defaulting to octet-stream). */
export function attachmentContentType(att: Attachment): string {
  return att.contentType && att.contentType.length > 0
    ? att.contentType
    : "application/octet-stream";
}
