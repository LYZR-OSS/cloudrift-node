import type {
  ServiceBusClient,
  ServiceBusMessageBatch,
  ServiceBusReceiver,
  ServiceBusReceivedMessage,
  ServiceBusSender,
} from "@azure/service-bus";

import { loadOptional } from "../core/lazy.js";
import { MessagingError, QueueNotFoundError, MessageSendError } from "../core/errors.js";
import { MessagingBackend, type Message } from "./base.js";

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
}

export interface AzureBusConnectionStringOptions {
  connectionString: string;
  queueName: string;
}

export interface AzureBusManagedIdentityOptions {
  fullyQualifiedNamespace: string;
  queueName: string;
  clientId?: string;
}

export interface AzureBusServicePrincipalOptions {
  fullyQualifiedNamespace: string;
  queueName: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
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
    this.init = init;
  }

  // ------------------------------------------------------------------
  // Factory constructors
  // ------------------------------------------------------------------

  /** Authenticate with a Service Bus connection string. */
  static fromConnectionString(
    opts: AzureBusConnectionStringOptions,
  ): AzureServiceBusBackend {
    return new AzureServiceBusBackend({
      queueName: opts.queueName,
      connectionString: opts.connectionString,
    });
  }

  /** Authenticate via Azure Managed Identity (system or user-assigned). */
  static fromManagedIdentity(
    opts: AzureBusManagedIdentityOptions,
  ): AzureServiceBusBackend {
    return new AzureServiceBusBackend({
      queueName: opts.queueName,
      fullyQualifiedNamespace: opts.fullyQualifiedNamespace,
      credentialFactory: (identity) =>
        opts.clientId !== undefined
          ? new identity.ManagedIdentityCredential({ clientId: opts.clientId })
          : new identity.ManagedIdentityCredential(),
    });
  }

  /** Authenticate via Azure AD service principal (client secret). */
  static fromServicePrincipal(
    opts: AzureBusServicePrincipalOptions,
  ): AzureServiceBusBackend {
    return new AzureServiceBusBackend({
      queueName: opts.queueName,
      fullyQualifiedNamespace: opts.fullyQualifiedNamespace,
      credentialFactory: (identity) =>
        new identity.ClientSecretCredential(
          opts.tenantId,
          opts.clientId,
          opts.clientSecret,
        ),
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

  private async createClient(): Promise<ServiceBusClient> {
    const sdk = await loadOptional<ServiceBusModule>(SB_PACKAGE, PROVIDER);
    if (this.init.connectionString) {
      this.client = new sdk.ServiceBusClient(this.init.connectionString);
    } else {
      const identity = await loadOptional<IdentityModule>(
        IDENTITY_PACKAGE,
        PROVIDER,
      );
      const credential = this.init.credentialFactory!(identity) as
        & ClosableCredential
        & object;
      this.credential = credential;
      this.client = new sdk.ServiceBusClient(
        this.init.fullyQualifiedNamespace!,
        credential as never,
      );
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
    if (this.credential?.close !== undefined) {
      await this.credential.close();
      this.credential = undefined;
    }
  }

  // ------------------------------------------------------------------
  // MessagingBackend implementation
  // ------------------------------------------------------------------

  async send(message: Record<string, unknown>, delay = 0): Promise<string> {
    const client = await this.ensure();
    const sender: ServiceBusSender = client.createSender(this.queueName);
    try {
      const sbMessage = { body: JSON.stringify(message) };
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

  async sendBatch(messages: Array<Record<string, unknown>>): Promise<string[]> {
    const client = await this.ensure();
    const sender: ServiceBusSender = client.createSender(this.queueName);
    try {
      let batch: ServiceBusMessageBatch = await sender.createMessageBatch();
      let batchSize = 0;
      const ids: string[] = [];
      for (const m of messages) {
        const message = { body: JSON.stringify(m) };
        if (!batch.tryAddMessage(message)) {
          if (batchSize === 0) {
            throw new MessageSendError(
              "Message is too large for an Azure Service Bus batch",
            );
          }
          await sender.sendMessages(batch);
          batch = await sender.createMessageBatch();
          batchSize = 0;
          if (!batch.tryAddMessage(message)) {
            throw new MessageSendError(
              "Message is too large for an Azure Service Bus batch",
            );
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

  async receive(maxMessages = 1, waitTime = 0): Promise<Message[]> {
    const client = await this.ensure();
    const receiver: ServiceBusReceiver = client.createReceiver(this.queueName);
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
        });
      }
      this.receiverTokens.set(receiver, { receiver, tokens });
      return messages;
    } catch (err) {
      await receiver.close();
      throw this.mapReceiveError(err);
    }
  }

  async delete(receiptHandle: string): Promise<void> {
    const entry = this.pending.get(receiptHandle);
    if (entry === undefined) {
      throw new MessagingError(
        `No pending message for receipt handle: ${JSON.stringify(receiptHandle)}. ` +
          "Call receive() first and use the returned receiptHandle.",
      );
    }
    this.pending.delete(receiptHandle);
    const { receiver, message } = entry;
    try {
      await receiver.completeMessage(message);
    } catch (err) {
      throw this.mapReceiveError(err);
    } finally {
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
  }

  override async healthCheck(): Promise<boolean> {
    try {
      const client = await this.ensure();
      const sender = client.createSender(this.queueName);
      await sender.close();
      return true;
    } catch {
      return false;
    }
  }

  async purge(): Promise<void> {
    const client = await this.ensure();
    const receiver: ServiceBusReceiver = client.createReceiver(this.queueName);
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
    } catch (err) {
      throw this.mapReceiveError(err);
    } finally {
      await receiver.close();
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
