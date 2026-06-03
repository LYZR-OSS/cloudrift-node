/**
 * Messaging domain contract.
 *
 * Mirrors `cloudrift-py/cloudrift/messaging/base.py`. A {@link Message} is the
 * normalized envelope returned by {@link MessagingBackend.receive}; the
 * `receiptHandle` is the opaque token a backend needs to acknowledge/delete the
 * message (an SQS receipt handle, a Service Bus lock token, etc.).
 *
 * Backends hold long-lived clients; call `close()` (or use `await using`) to
 * release sockets/connections.
 */

/** Normalized message envelope returned by {@link MessagingBackend.receive}. */
export interface Message {
  id: string;
  body: Record<string, unknown>;
  receiptHandle: string;
  attributes: Record<string, unknown>;
}

/** Abstract base class for cloud messaging/queue backends. */
export abstract class MessagingBackend {
  /** Send a message. Returns the message ID. */
  abstract send(message: Record<string, unknown>, delay?: number): Promise<string>;

  /** Send multiple messages. Returns the list of message IDs. */
  abstract sendBatch(messages: Array<Record<string, unknown>>): Promise<string[]>;

  /** Receive messages. `waitTime` is the long-poll duration in seconds. */
  abstract receive(maxMessages?: number, waitTime?: number): Promise<Message[]>;

  /** Delete/acknowledge a message by its receipt handle. */
  abstract delete(receiptHandle: string): Promise<void>;

  /** Delete all messages in the queue. */
  abstract purge(): Promise<void>;

  /** Return true if the messaging backend is reachable. */
  healthCheck(): Promise<boolean> {
    return Promise.resolve(true);
  }

  /** Close the underlying client and release sockets. Default is a no-op. */
  close(): Promise<void> {
    return Promise.resolve();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
