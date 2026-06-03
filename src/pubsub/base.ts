/**
 * Pub/Sub (topic-based fan-out) abstraction.
 *
 * Unlike `MessagingBackend` (point-to-point queues), pub/sub backends fan out
 * messages to multiple subscribers via topics. Backends hold long-lived clients;
 * use `await backend.close()` (or `await using backend = ...`) to release sockets.
 *
 * Mirrors `cloudrift-py`'s `cloudrift/pubsub/base.py`.
 */

/** A single message for batch publishing. */
export interface PubSubMessage {
  /** The message body. */
  message: string;
  /** Optional string attributes attached to the message. */
  attributes?: Record<string, string>;
}

/** Abstract base class for cloud pub/sub (topic-based) backends. */
export abstract class PubSubBackend {
  /** Publish a message to a topic. Returns the message ID. */
  abstract publish(
    topic: string,
    message: string,
    attributes?: Record<string, string>,
  ): Promise<string>;

  /** Publish multiple messages to a topic. Returns the list of message IDs. */
  abstract publishBatch(topic: string, messages: PubSubMessage[]): Promise<string[]>;

  /** Return true if the pub/sub backend is reachable. Default is a best-effort `true`. */
  async healthCheck(): Promise<boolean> {
    return true;
  }

  /** Close the underlying client and release sockets. Default is a no-op. */
  async close(): Promise<void> {
    /* no-op */
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
