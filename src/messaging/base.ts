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
 *
 * FIFO / ordered queues: `groupId` maps to SQS `MessageGroupId` and Service Bus
 * `sessionId`; `dedupId` maps to SQS `MessageDeduplicationId` and Service Bus
 * `messageId` (effective only when the queue has duplicate detection enabled).
 */

import { FeatureNotSupportedError } from "../core/errors.js";

/** Optional FIFO/ordering controls for a single send. */
export interface SendOptions {
  /** SQS `MessageGroupId` / Service Bus `sessionId`. Required on FIFO/session queues. */
  groupId?: string;
  /** SQS `MessageDeduplicationId` / Service Bus `messageId`. */
  dedupId?: string;
}

/** Optional FIFO/ordering controls for a batch send. */
export interface SendBatchOptions {
  /** Applies to every message in the batch. */
  groupId?: string;
  /** If given, must be parallel to the messages array. */
  dedupIds?: string[];
}

/** Optional controls for a receive. */
export interface ReceiveOptions {
  /**
   * Receive from a specific session/group (Service Bus only; SQS cannot filter
   * by group).
   */
  groupId?: string;
  /**
   * Override the queue's visibility timeout (SQS only); ignored on Service Bus
   * (lock duration is queue-level configuration).
   */
  visibilityTimeout?: number;
}

/** Normalized message envelope returned by {@link MessagingBackend.receive}. */
export interface Message {
  id: string;
  body: Record<string, unknown>;
  receiptHandle: string;
  attributes: Record<string, unknown>;
  /** SQS `MessageGroupId` / Service Bus `sessionId`, when present. */
  groupId?: string;
  /** SQS `MessageDeduplicationId` / Service Bus `messageId`, when present. */
  dedupId?: string;
  /** Approximate delivery count for this message, when reported by the backend. */
  receiveCount?: number;
}

/** Abstract base class for cloud messaging/queue backends. */
export abstract class MessagingBackend {
  /**
   * Send a message. Returns the message ID.
   *
   * `groupId`/`dedupId` apply to FIFO (SQS) or session-enabled (Service Bus)
   * queues. SQS FIFO does not support per-message `delay`.
   */
  abstract send(
    message: Record<string, unknown>,
    delay?: number,
    options?: SendOptions,
  ): Promise<string>;

  /**
   * Send multiple messages. Returns the list of message IDs.
   *
   * `groupId` applies to every message; `dedupIds`, if given, must be parallel
   * to `messages`.
   */
  abstract sendBatch(
    messages: Array<Record<string, unknown>>,
    options?: SendBatchOptions,
  ): Promise<string[]>;

  /**
   * Receive messages. `waitTime` is the long-poll duration in seconds.
   *
   * `groupId` receives from a specific session (Service Bus only; SQS cannot
   * filter by group). `visibilityTimeout` overrides the queue's visibility
   * timeout on SQS; ignored on Service Bus (lock duration is queue-level
   * configuration).
   */
  abstract receive(
    maxMessages?: number,
    waitTime?: number,
    options?: ReceiveOptions,
  ): Promise<Message[]>;

  /** Delete/acknowledge a message by its receipt handle. */
  abstract delete(receiptHandle: string): Promise<void>;

  /** Return a message to the queue for immediate redelivery. */
  nack(_receiptHandle: string): Promise<void> {
    return Promise.reject(
      new FeatureNotSupportedError(`${this.constructor.name} does not support nack()`),
    );
  }

  /**
   * Move a received message to the dead-letter queue and acknowledge it.
   *
   * Azure Service Bus implements this natively via `deadLetterMessage`. SQS has
   * no native per-message dead-letter API, so backends emulate it by sending the
   * message body to a configured dead-letter queue and then deleting the
   * original from the source queue.
   */
  abstract deadLetter(receiptHandle: string, reason: string): Promise<void>;

  /**
   * Return the approximate number of messages waiting in the queue.
   *
   * This is an estimate: cloud queues report it asynchronously and it may lag
   * in-flight (received-but-not-yet-deleted) messages.
   */
  abstract getQueueDepth(): Promise<number>;

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
