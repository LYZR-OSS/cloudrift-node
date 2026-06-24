import type {
  ServiceBusClient,
  ServiceBusMessage,
  ServiceBusMessageBatch,
  ServiceBusReceiver,
  ServiceBusReceivedMessage,
  ServiceBusSender,
} from "@azure/service-bus";

import { loadOptional } from "../core/lazy.js";
import {
  FeatureNotSupportedError,
  MessagingError,
  QueueNotFoundError,
  MessageSendError,
} from "../core/errors.js";
import {
  MessagingBackend,
  type Message,
  type SendOptions,
  type SendBatchOptions,
  type ReceiveOptions,
} from "./base.js";

const PROVIDER = "azure_service_bus";
const SB_PACKAGE = "@azure/service-bus";
const IDENTITY_PACKAGE = "@azure/identity";

type ServiceBusModule = typeof import("@azure/service-bus");
type IdentityModule = typeof import("@azure/identity");

/** A credential that may optionally expose an async `close()` (Azure identity creds do). */
interface ClosableCredential {
  close?: () => Promise<void>;
}

interface AzureBusInit {
  queueName: string;
  connectionString?: string;
  fullyQualifiedNamespace?: string;
  credentialFactory?: (identity: IdentityModule) => unknown;
  sessionEnabled?: boolean;
}

export interface AzureBusConnectionStringOptions {
  connectionString: string;
  queueName: string;
  /** Set true for session-enabled (FIFO-style) queues. */
  sessionEnabled?: boolean;
}

export interface AzureBusManagedIdentityOptions {
  fullyQualifiedNamespace: string;
  queueName: string;
  clientId?: string;
  /** Set true for session-enabled (FIFO-style) queues. */
  sessionEnabled?: boolean;
}

export interface AzureBusServicePrincipalOptions {
  fullyQualifiedNamespace: string;
  queueName: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Set true for session-enabled (FIFO-style) queues. */
  sessionEnabled?: boolean;
}

/** Tracks the receiver and message for a single in-flight (peek-locked) lock token. */
interface PendingEntry {
  receiver: ServiceBusReceiver;
  message: ServiceBusReceivedMessage;
}

/** Tracks a receiver and the set of lock tokens still outstanding against it. */
interface ReceiverEntry {
  receiver: ServiceBusReceiver;
  tokens: Set<string>;
}

/**
 * Azure Service Bus messaging backend (native async via `@azure/service-bus`).
 *
 * A single `ServiceBusClient` (one AMQP connection) is opened lazily and reused
 * for the lifetime of the backend. Senders are short-lived (one per send call);
 * receivers are kept open while any message they yielded is still un-acked.
 *
 * KNOWN DEBT — SQS/Service Bus ack mismatch: SQS receipt handles are stateless
 * tokens that can be deleted by any client, so the SQS backend's `delete()` is a
 * pure server call. Service Bus settlement, by contrast, is bound to the *exact*
 * receiver object that peek-locked the message. To present the same
 * `receive()`/`delete(receiptHandle)` contract, this backend uses the message's
 * `lockToken` as the `receiptHandle` and keeps a `pending` map from lock token to
 * `{ receiver, message }`, plus a per-receiver token count. `delete()` looks the
 * token up, completes the message on its owning receiver, and closes that
 * receiver once its last token is acked. Consequences vs. SQS: a `receiptHandle`
 * is only meaningful within the process that received it, the lock can expire,
 * and abandoned (never-deleted) messages keep their receiver open until `close()`.
 */
export class AzureServiceBusBackend extends MessagingBackend {
  readonly queueName: string;
  readonly sessionEnabled: boolean;

  private readonly init: AzureBusInit;
  private clientPromise: Promise<ServiceBusClient> | undefined;
  private client: ServiceBusClient | undefined;
  private credential: (ClosableCredential & object) | undefined;

  // lockToken -> { receiver, message }
  private readonly pending = new Map<string, PendingEntry>();
  // receiver identity -> { receiver, tokens }
  private readonly receiverTokens = new Map<ServiceBusReceiver, ReceiverEntry>();

  private constructor(init: AzureBusInit) {
    super();
    if (!init.connectionString && !init.fullyQualifiedNamespace) {
      throw new MessagingError(
        "Provide either connectionString or fullyQualifiedNamespace + credential",
      );
    }
    this.queueName = init.queueName;
    this.sessionEnabled = init.sessionEnabled ?? false;
    this.init = init;
  }

  // ------------------------------------------------------------------
  // Factory constructors
  // ------------------------------------------------------------------

  /** Authenticate with a Service Bus connection string. */
  static fromConnectionString(opts: AzureBusConnectionStringOptions): AzureServiceBusBackend {
    return new AzureServiceBusBackend({
      queueName: opts.queueName,
      connectionString: opts.connectionString,
      sessionEnabled: opts.sessionEnabled,
    });
  }

  /** Authenticate via Azure Managed Identity (system or user-assigned). */
  static fromManagedIdentity(opts: AzureBusManagedIdentityOptions): AzureServiceBusBackend {
    return new AzureServiceBusBackend({
      queueName: opts.queueName,
      fullyQualifiedNamespace: opts.fullyQualifiedNamespace,
      credentialFactory: (identity) =>
        opts.clientId !== undefined
          ? new identity.ManagedIdentityCredential({ clientId: opts.clientId })
          : new identity.ManagedIdentityCredential(),
      sessionEnabled: opts.sessionEnabled,
    });
  }

  /** Authenticate via Azure AD service principal (client secret). */
  static fromServicePrincipal(opts: AzureBusServicePrincipalOptions): AzureServiceBusBackend {
    return new AzureServiceBusBackend({
      queueName: opts.queueName,
      fullyQualifiedNamespace: opts.fullyQualifiedNamespace,
      credentialFactory: (identity) =>
        new identity.ClientSecretCredential(opts.tenantId, opts.clientId, opts.clientSecret),
      sessionEnabled: opts.sessionEnabled,
    });
  }

  // ------------------------------------------------------------------
  // Lifecycle (single client / single AMQP connection reused)
  // ------------------------------------------------------------------

  private ensure(): Promise<ServiceBusClient> {
    if (this.clientPromise === undefined) {
      this.clientPromise = this.createClient();
    }
    return this.clientPromise;
  }

  private async ensureClient(): Promise<ServiceBusClient> {
    try {
      return await this.ensure();
    } catch (err) {
      this.clientPromise = undefined;
      this.client = undefined;
      this.credential = undefined;
      throw err;
    }
  }

  private async createClient(): Promise<ServiceBusClient> {
    const sdk = await loadOptional<ServiceBusModule>(SB_PACKAGE, PROVIDER);
    if (this.init.connectionString) {
      this.client = new sdk.ServiceBusClient(this.init.connectionString);
    } else {
      const identity = await loadOptional<IdentityModule>(IDENTITY_PACKAGE, PROVIDER);
      const credential = this.init.credentialFactory!(identity) as ClosableCredential & object;
      this.credential = credential;
      try {
        this.client = new sdk.ServiceBusClient(
          this.init.fullyQualifiedNamespace!,
          credential as never,
        );
      } catch (err) {
        await this.closeCredential();
        throw err;
      }
    }
    return this.client;
  }

  override async close(): Promise<void> {
    for (const { receiver } of this.receiverTokens.values()) {
      try {
        await receiver.close();
      } catch {
        // best-effort
      }
    }
    this.receiverTokens.clear();
    this.pending.clear();
    if (this.client !== undefined) {
      await this.client.close();
      this.client = undefined;
      this.clientPromise = undefined;
    }
    await this.closeCredential();
  }

  private async closeCredential(): Promise<void> {
    if (this.credential?.close !== undefined) {
      await this.credential.close();
    }
    this.credential = undefined;
  }

  // ------------------------------------------------------------------
  // MessagingBackend implementation
  // ------------------------------------------------------------------

  /** Build a Service Bus message, validating session requirements. */
  private buildMessage(
    message: Record<string, unknown>,
    groupId: string | undefined,
    dedupId: string | undefined,
  ): ServiceBusMessage {
    if (this.sessionEnabled && !groupId) {
      throw new MessageSendError(
        `groupId is required when sending to session-enabled queue ${JSON.stringify(this.queueName)}`,
      );
    }
    const sbMessage: ServiceBusMessage = { body: JSON.stringify(message) };
    if (groupId) {
      sbMessage.sessionId = groupId;
    }
    if (dedupId) {
      sbMessage.messageId = dedupId;
    }
    return sbMessage;
  }

  async send(
    message: Record<string, unknown>,
    delay = 0,
    options: SendOptions = {},
  ): Promise<string> {
    const client = await this.ensureClient();
    const sbMessage = this.buildMessage(message, options.groupId, options.dedupId);
    const sender: ServiceBusSender = client.createSender(this.queueName);
    try {
      if (delay > 0) {
        const scheduledTime = new Date(Date.now() + delay * 1000);
        await sender.scheduleMessages(sbMessage, scheduledTime);
      } else {
        await sender.sendMessages(sbMessage);
      }
      return "";
    } catch (err) {
      throw this.mapSendError(err);
    } finally {
      await sender.close();
    }
  }

  async sendBatch(
    messages: Array<Record<string, unknown>>,
    options: SendBatchOptions = {},
  ): Promise<string[]> {
    const client = await this.ensureClient();
    const { groupId, dedupIds } = options;
    if (dedupIds !== undefined && dedupIds.length !== messages.length) {
      throw new MessageSendError("dedupIds must be parallel to messages");
    }
    const sbMessages = messages.map((m, i) =>
      this.buildMessage(m, groupId, dedupIds ? dedupIds[i] : undefined),
    );
    const sender: ServiceBusSender = client.createSender(this.queueName);
    try {
      let batch: ServiceBusMessageBatch = await sender.createMessageBatch();
      let batchSize = 0;
      const ids: string[] = [];
      for (const message of sbMessages) {
        if (!batch.tryAddMessage(message)) {
          if (batchSize === 0) {
            throw new MessageSendError("Message is too large for an Azure Service Bus batch");
          }
          await sender.sendMessages(batch);
          batch = await sender.createMessageBatch();
          batchSize = 0;
          if (!batch.tryAddMessage(message)) {
            throw new MessageSendError("Message is too large for an Azure Service Bus batch");
          }
        }
        batchSize += 1;
        ids.push("");
      }
      if (batchSize > 0) {
        await sender.sendMessages(batch);
      }
      return ids;
    } catch (err) {
      throw this.mapSendError(err);
    } finally {
      await sender.close();
    }
  }

  async receive(maxMessages = 1, waitTime = 0, options: ReceiveOptions = {}): Promise<Message[]> {
    // visibilityTimeout is intentionally ignored: Service Bus lock duration is
    // fixed at the queue level.
    const client = await this.ensureClient();
    let receiver: ServiceBusReceiver;
    if (this.sessionEnabled) {
      try {
        receiver =
          options.groupId !== undefined
            ? await client.acceptSession(this.queueName, options.groupId, {
                maxAutoLockRenewalDurationInMs: 0,
              })
            : await client.acceptNextSession(this.queueName, {
                maxAutoLockRenewalDurationInMs: 0,
              });
      } catch (err) {
        if (isNoSessionAvailable(err)) {
          // No session currently has messages — normal in polling loops.
          return [];
        }
        throw this.mapReceiveError(err);
      }
    } else {
      if (options.groupId !== undefined) {
        throw new FeatureNotSupportedError(
          "groupId receive requires a session-enabled queue " +
            "(construct the backend with sessionEnabled: true)",
        );
      }
      receiver = client.createReceiver(this.queueName);
    }
    try {
      const raw = await receiver.receiveMessages(maxMessages, {
        maxWaitTimeInMs: waitTime > 0 ? waitTime * 1000 : undefined,
      });
      if (raw.length === 0) {
        await receiver.close();
        return [];
      }
      const tokens = new Set<string>();
      const messages: Message[] = [];
      for (const m of raw) {
        const token = String(m.lockToken ?? "");
        this.pending.set(token, { receiver, message: m });
        tokens.add(token);
        messages.push({
          id: String(m.messageId ?? ""),
          body: parseBody(m.body),
          receiptHandle: token,
          attributes: {
            sequence_number: m.sequenceNumber ?? null,
            enqueued_time: String(m.enqueuedTimeUtc ?? ""),
          },
          groupId: m.sessionId ?? undefined,
          dedupId: m.messageId !== undefined ? String(m.messageId) : undefined,
          receiveCount: (m.deliveryCount ?? 0) + 1,
        });
      }
      this.receiverTokens.set(receiver, { receiver, tokens });
      return messages;
    } catch (err) {
      await receiver.close();
      if (isNoSessionAvailable(err)) {
        // A receive-time timeout (Python's OperationTimeoutError, azure_bus.py:291)
        // means no message arrived within the wait window — treat as empty.
        return [];
      }
      throw this.mapReceiveError(err);
    }
  }

  /** Pop the pending entry for a lock token or throw if it is unknown. */
  private takePending(receiptHandle: string): PendingEntry {
    const entry = this.pending.get(receiptHandle);
    if (entry === undefined) {
      throw new MessagingError(
        `No pending message for receipt handle: ${JSON.stringify(receiptHandle)}. ` +
          "Call receive() first and use the returned receiptHandle.",
      );
    }
    this.pending.delete(receiptHandle);
    return entry;
  }

  /** Drop the token from the receiver's set; close the receiver when empty. */
  private async releaseToken(receiptHandle: string, receiver: ServiceBusReceiver): Promise<void> {
    const rEntry = this.receiverTokens.get(receiver);
    if (rEntry !== undefined) {
      rEntry.tokens.delete(receiptHandle);
      if (rEntry.tokens.size === 0) {
        try {
          await receiver.close();
        } catch {
          // best-effort
        }
        this.receiverTokens.delete(receiver);
      }
    }
  }

  async delete(receiptHandle: string): Promise<void> {
    const { receiver, message } = this.takePending(receiptHandle);
    try {
      await receiver.completeMessage(message);
    } catch (err) {
      throw this.mapReceiveError(err);
    } finally {
      await this.releaseToken(receiptHandle, receiver);
    }
  }

  /** Abandon the message so Service Bus redelivers it immediately. */
  override async nack(receiptHandle: string): Promise<void> {
    const { receiver, message } = this.takePending(receiptHandle);
    try {
      await receiver.abandonMessage(message);
    } catch (err) {
      throw this.mapReceiveError(err);
    } finally {
      await this.releaseToken(receiptHandle, receiver);
    }
  }

  async deadLetter(receiptHandle: string, reason: string): Promise<void> {
    const { receiver, message } = this.takePending(receiptHandle);
    try {
      await receiver.deadLetterMessage(message, {
        deadLetterReason: reason,
        deadLetterErrorDescription: reason,
      });
    } catch (err) {
      throw this.mapReceiveError(err);
    } finally {
      await this.releaseToken(receiptHandle, receiver);
    }
  }

  async getQueueDepth(): Promise<number> {
    // Message counts live on the management plane, not the data plane.
    const sdk = await loadOptional<ServiceBusModule>(SB_PACKAGE, PROVIDER);
    let admin: InstanceType<ServiceBusModule["ServiceBusAdministrationClient"]>;
    if (this.init.connectionString) {
      admin = new sdk.ServiceBusAdministrationClient(this.init.connectionString);
    } else {
      // Reuse the long-lived credential built for the data-plane client rather
      // than minting (and leaking) a fresh one per call. ensureClient()
      // populates this.credential on the namespace+credential path. Mirrors
      // Python (azure_bus.py:388) which passes self._credential.
      await this.ensureClient();
      admin = new sdk.ServiceBusAdministrationClient(
        this.init.fullyQualifiedNamespace!,
        this.credential as never,
      );
    }
    try {
      const props = await admin.getQueueRuntimeProperties(this.queueName);
      return props.activeMessageCount;
    } catch (err) {
      throw this.mapReceiveError(err);
    }
  }

  override async healthCheck(): Promise<boolean> {
    try {
      const client = await this.ensureClient();
      const sender = client.createSender(this.queueName);
      await sender.close();
      return true;
    } catch {
      return false;
    }
  }

  private async purgeReceiver(receiver: ServiceBusReceiver): Promise<void> {
    try {
      for (;;) {
        const messages = await receiver.receiveMessages(100, {
          maxWaitTimeInMs: 5000,
        });
        if (messages.length === 0) {
          break;
        }
        for (const msg of messages) {
          await receiver.completeMessage(msg);
        }
      }
    } finally {
      await receiver.close();
    }
  }

  async purge(): Promise<void> {
    const client = await this.ensureClient();
    try {
      if (this.sessionEnabled) {
        // Drain one session at a time until no session is available.
        for (;;) {
          let receiver: ServiceBusReceiver;
          try {
            receiver = await client.acceptNextSession(this.queueName, {
              maxAutoLockRenewalDurationInMs: 0,
            });
          } catch (err) {
            if (isNoSessionAvailable(err)) {
              break;
            }
            throw err;
          }
          await this.purgeReceiver(receiver);
        }
      } else {
        await this.purgeReceiver(client.createReceiver(this.queueName));
      }
    } catch (err) {
      throw this.mapReceiveError(err);
    }
  }

  private mapSendError(err: unknown): Error {
    if (err instanceof MessageSendError) {
      return err;
    }
    if (isEntityNotFound(err)) {
      return new QueueNotFoundError(`Queue not found: ${this.queueName}`, {
        cause: err,
      });
    }
    return new MessageSendError(errorMessage(err), { cause: err });
  }

  private mapReceiveError(err: unknown): Error {
    if (err instanceof MessagingError) {
      return err;
    }
    if (isEntityNotFound(err)) {
      return new QueueNotFoundError(`Queue not found: ${this.queueName}`, {
        cause: err,
      });
    }
    return new MessagingError(errorMessage(err), { cause: err });
  }
}

function parseBody(body: unknown): Record<string, unknown> {
  if (typeof body === "string") {
    return JSON.parse(body) as Record<string, unknown>;
  }
  if (body !== null && typeof body === "object") {
    return body as Record<string, unknown>;
  }
  return JSON.parse(String(body)) as Record<string, unknown>;
}

function isEntityNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === "MessagingEntityNotFound";
}

/**
 * True when accepting a session timed out because no session currently holds
 * messages. The JS Service Bus SDK surfaces this as a `ServiceBusError` whose
 * `code` is `"ServiceTimeout"` (or `"SessionCannotBeLocked"` when another
 * receiver already holds every available session). This is the JS analogue of
 * Python's `OperationTimeoutError`.
 */
function isNoSessionAvailable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === "ServiceTimeout" || code === "SessionCannotBeLocked";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
