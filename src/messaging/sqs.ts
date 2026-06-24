import type {
  SQSClient,
  SQSClientConfig,
  SendMessageCommandOutput,
  SendMessageBatchCommandOutput,
  ReceiveMessageCommandOutput,
  GetQueueAttributesCommandOutput,
  GetQueueUrlCommandOutput,
} from "@aws-sdk/client-sqs";

import { loadOptional } from "../core/lazy.js";
import {
  FeatureNotSupportedError,
  MessageSendError,
  MessagingError,
  QueueNotFoundError,
} from "../core/errors.js";
import {
  MessagingBackend,
  type Message,
  type SendOptions,
  type SendBatchOptions,
  type ReceiveOptions,
} from "./base.js";

const PROVIDER = "sqs";
const SQS_PACKAGE = "@aws-sdk/client-sqs";

/** Shape of the lazily-imported `@aws-sdk/client-sqs` module. */
type SqsModule = typeof import("@aws-sdk/client-sqs");

/** AWS auth/transport configuration captured at construction time. */
export interface SqsBackendConfig {
  endpointUrl?: string;
  /**
   * Explicit dead-letter queue URL. If omitted it is resolved lazily from the
   * source queue's RedrivePolicy the first time `deadLetter()` is called.
   */
  dlqUrl?: string;
  maxPoolConnections?: number;
  connectTimeout?: number;
  readTimeout?: number;
}

interface SqsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface SqsInit extends SqsBackendConfig {
  queueUrl: string;
  region?: string;
  profile?: string;
  credentials?: SqsCredentials;
}

export interface SqsAccessKeyOptions extends SqsBackendConfig {
  queueUrl: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken?: string;
  region?: string;
}

export interface SqsIamRoleOptions extends SqsBackendConfig {
  queueUrl: string;
  region?: string;
}

export interface SqsProfileOptions extends SqsBackendConfig {
  queueUrl: string;
  profileName: string;
  region?: string;
}

const DEFAULT_REGION = "us-east-1";

// Match Python sqs.py botocore Config defaults.
const DEFAULT_MAX_POOL_CONNECTIONS = 50;
const DEFAULT_CONNECT_TIMEOUT = 10; // seconds
const DEFAULT_READ_TIMEOUT = 60; // seconds
const SQS_SEND_BATCH_LIMIT = 10;

/**
 * AWS SQS messaging backend (native async via `@aws-sdk/client-sqs`).
 *
 * A single `SQSClient` is created lazily on first use (promise-memoized,
 * equivalent of the Python `asyncio.Lock`-guarded `_ensure`) and reused across
 * operations. Call `close()` (or use `await using`) to release connections.
 */
export class AWSSQSBackend extends MessagingBackend {
  readonly queueUrl: string;

  private readonly init: SqsInit;
  private readonly isFifo: boolean;
  private clientPromise: Promise<SQSClient> | undefined;
  private client: SQSClient | undefined;
  // Explicit DLQ URL; if undefined it is resolved lazily from the source
  // queue's RedrivePolicy the first time deadLetter() is called.
  private dlqUrl: string | undefined;
  // receiptHandle -> raw message body (JSON string), retained between
  // receive() and delete()/deadLetter() so emulated dead-lettering can re-send
  // the original payload to the DLQ.
  private readonly pending = new Map<string, string>();

  private constructor(init: SqsInit) {
    super();
    this.queueUrl = init.queueUrl;
    this.isFifo = init.queueUrl.endsWith(".fifo");
    this.dlqUrl = init.dlqUrl;
    this.init = init;
  }

  // ------------------------------------------------------------------
  // Factory constructors
  // ------------------------------------------------------------------

  /** Authenticate with explicit access key / secret (+ optional STS session token). */
  static fromAccessKey(opts: SqsAccessKeyOptions): AWSSQSBackend {
    return new AWSSQSBackend({
      queueUrl: opts.queueUrl,
      region: opts.region ?? DEFAULT_REGION,
      credentials: {
        accessKeyId: opts.awsAccessKeyId,
        secretAccessKey: opts.awsSecretAccessKey,
        sessionToken: opts.awsSessionToken,
      },
      endpointUrl: opts.endpointUrl,
      dlqUrl: opts.dlqUrl,
      maxPoolConnections: opts.maxPoolConnections,
      connectTimeout: opts.connectTimeout,
      readTimeout: opts.readTimeout,
    });
  }

  /** Authenticate via IAM role / instance profile / environment variables. */
  static fromIamRole(opts: SqsIamRoleOptions): AWSSQSBackend {
    return new AWSSQSBackend({
      queueUrl: opts.queueUrl,
      region: opts.region ?? DEFAULT_REGION,
      endpointUrl: opts.endpointUrl,
      dlqUrl: opts.dlqUrl,
      maxPoolConnections: opts.maxPoolConnections,
      connectTimeout: opts.connectTimeout,
      readTimeout: opts.readTimeout,
    });
  }

  /** Authenticate using a named profile from `~/.aws/credentials`. */
  static fromProfile(opts: SqsProfileOptions): AWSSQSBackend {
    return new AWSSQSBackend({
      queueUrl: opts.queueUrl,
      region: opts.region ?? DEFAULT_REGION,
      profile: opts.profileName,
      endpointUrl: opts.endpointUrl,
      dlqUrl: opts.dlqUrl,
      maxPoolConnections: opts.maxPoolConnections,
      connectTimeout: opts.connectTimeout,
      readTimeout: opts.readTimeout,
    });
  }

  // ------------------------------------------------------------------
  // Internal lifecycle (lazy, promise-memoized client init)
  // ------------------------------------------------------------------

  private ensure(): Promise<SQSClient> {
    if (this.clientPromise === undefined) {
      this.clientPromise = this.createClient();
    }
    return this.clientPromise;
  }

  private async ensureClient(): Promise<SQSClient> {
    try {
      return await this.ensure();
    } catch (err) {
      this.clientPromise = undefined;
      this.client = undefined;
      throw err;
    }
  }

  private async createClient(): Promise<SQSClient> {
    const sdk = await loadOptional<SqsModule>(SQS_PACKAGE, PROVIDER);
    // Apply transport tuning (pool size + timeouts), mirroring Python's
    // botocore Config(max_pool_connections=50, connect_timeout=10,
    // read_timeout=60). Defaults match Python when the caller leaves them unset.
    const connectTimeout = this.init.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
    const readTimeout = this.init.readTimeout ?? DEFAULT_READ_TIMEOUT;
    const maxPoolConnections = this.init.maxPoolConnections ?? DEFAULT_MAX_POOL_CONNECTIONS;
    const config: SQSClientConfig = {
      region: this.init.region,
      requestHandler: {
        connectionTimeout: connectTimeout * 1000,
        requestTimeout: readTimeout * 1000,
        httpsAgent: { maxSockets: maxPoolConnections, keepAlive: true },
      },
    };
    if (this.init.endpointUrl !== undefined) {
      config.endpoint = this.init.endpointUrl;
    }
    if (this.init.credentials !== undefined) {
      config.credentials = {
        accessKeyId: this.init.credentials.accessKeyId,
        secretAccessKey: this.init.credentials.secretAccessKey,
        sessionToken: this.init.credentials.sessionToken,
      };
    } else if (this.init.profile !== undefined) {
      const credsMod = await loadOptional<typeof import("@aws-sdk/credential-providers")>(
        "@aws-sdk/credential-providers",
        PROVIDER,
      );
      config.credentials = credsMod.fromIni({ profile: this.init.profile });
    }
    this.client = new sdk.SQSClient(config);
    return this.client;
  }

  // ------------------------------------------------------------------
  // MessagingBackend implementation
  // ------------------------------------------------------------------

  /** Validate FIFO/standard constraints and return per-message kwargs. */
  private fifoParams(
    groupId: string | undefined,
    dedupId: string | undefined,
    delay = 0,
  ): Record<string, unknown> {
    if (this.isFifo) {
      if (delay) {
        throw new FeatureNotSupportedError(
          "SQS FIFO queues do not support per-message delay; " +
            "use a queue-level delivery delay instead",
        );
      }
      if (!groupId) {
        throw new MessageSendError("groupId is required when sending to an SQS FIFO queue");
      }
      const params: Record<string, unknown> = { MessageGroupId: groupId };
      if (dedupId) {
        params.MessageDeduplicationId = dedupId;
      }
      return params;
    }
    if (groupId || dedupId) {
      throw new FeatureNotSupportedError(
        "groupId/dedupId are only supported on SQS FIFO queues " + `(queue: ${this.queueUrl})`,
      );
    }
    return delay ? { DelaySeconds: delay } : {};
  }

  async send(
    message: Record<string, unknown>,
    delay = 0,
    options: SendOptions = {},
  ): Promise<string> {
    const client = await this.ensureClient();
    const sdk = await loadOptional<SqsModule>(SQS_PACKAGE, PROVIDER);
    const params = this.fifoParams(options.groupId, options.dedupId, delay);
    try {
      const response: SendMessageCommandOutput = await client.send(
        new sdk.SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(message),
          ...params,
        }),
      );
      return response.MessageId ?? "";
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async sendBatch(
    messages: Array<Record<string, unknown>>,
    options: SendBatchOptions = {},
  ): Promise<string[]> {
    const client = await this.ensureClient();
    const sdk = await loadOptional<SqsModule>(SQS_PACKAGE, PROVIDER);
    const { groupId, dedupIds } = options;
    if (dedupIds !== undefined && dedupIds.length !== messages.length) {
      throw new MessageSendError("dedupIds must be parallel to messages");
    }
    const ids: string[] = [];
    try {
      for (let offset = 0; offset < messages.length; offset += SQS_SEND_BATCH_LIMIT) {
        const chunk = messages.slice(offset, offset + SQS_SEND_BATCH_LIMIT);
        const entries = chunk.map((msg, i) => ({
          Id: String(offset + i),
          MessageBody: JSON.stringify(msg),
          ...this.fifoParams(groupId, dedupIds ? dedupIds[offset + i] : undefined),
        }));
        const response: SendMessageBatchCommandOutput = await client.send(
          new sdk.SendMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: entries,
          }),
        );
        if (response.Failed && response.Failed.length > 0) {
          const failed = response.Failed.map((f) => f.Id);
          throw new MessageSendError(`Failed to send messages with IDs: ${JSON.stringify(failed)}`);
        }
        ids.push(...(response.Successful ?? []).map((s) => s.MessageId ?? ""));
      }
      return ids;
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async receive(maxMessages = 1, waitTime = 0, options: ReceiveOptions = {}): Promise<Message[]> {
    if (options.groupId !== undefined) {
      throw new FeatureNotSupportedError("SQS cannot receive from a specific message group");
    }
    const client = await this.ensureClient();
    const sdk = await loadOptional<SqsModule>(SQS_PACKAGE, PROVIDER);
    const extra: Record<string, unknown> = {};
    if (options.visibilityTimeout !== undefined) {
      extra.VisibilityTimeout = options.visibilityTimeout;
    }
    try {
      const response: ReceiveMessageCommandOutput = await client.send(
        new sdk.ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: Math.min(maxMessages, 10),
          WaitTimeSeconds: waitTime,
          AttributeNames: ["All"],
          ...extra,
        }),
      );
      const messages: Message[] = [];
      for (const m of response.Messages ?? []) {
        const attrs = (m.Attributes ?? {}) as Record<string, string>;
        const receiveCountRaw = attrs.ApproximateReceiveCount;
        const receiptHandle = m.ReceiptHandle ?? "";
        this.pending.set(receiptHandle, m.Body ?? "{}");
        messages.push({
          id: m.MessageId ?? "",
          body: JSON.parse(m.Body ?? "{}") as Record<string, unknown>,
          receiptHandle,
          attributes: attrs,
          groupId: attrs.MessageGroupId,
          dedupId: attrs.MessageDeduplicationId,
          receiveCount: receiveCountRaw ? Number.parseInt(receiveCountRaw, 10) : undefined,
        });
      }
      return messages;
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /** Make the message immediately visible again for redelivery. */
  override async nack(receiptHandle: string): Promise<void> {
    const client = await this.ensureClient();
    const sdk = await loadOptional<SqsModule>(SQS_PACKAGE, PROVIDER);
    try {
      await client.send(
        new sdk.ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    } catch (err) {
      throw this.mapError(err);
    } finally {
      // the handle goes stale on redelivery; redelivery stores a new one
      this.pending.delete(receiptHandle);
    }
  }

  async delete(receiptHandle: string): Promise<void> {
    const client = await this.ensureClient();
    const sdk = await loadOptional<SqsModule>(SQS_PACKAGE, PROVIDER);
    try {
      await client.send(
        new sdk.DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
    } catch (err) {
      throw this.mapError(err);
    } finally {
      this.pending.delete(receiptHandle);
    }
  }

  /**
   * Emulated dead-letter for SQS: sends to the DLQ then deletes from source.
   *
   * Warning: these are two separate API calls with no cross-queue transaction.
   * If the process dies between them (or the DLQ send succeeds but the delete
   * fails), the message may appear in both queues (double-processed) or in
   * neither (lost). For strict dead-lettering, prefer the native SQS redrive
   * policy and let the service move the message after maxReceiveCount.
   */
  async deadLetter(receiptHandle: string, reason: string): Promise<void> {
    const client = await this.ensureClient();
    const sdk = await loadOptional<SqsModule>(SQS_PACKAGE, PROVIDER);
    const body = this.pending.get(receiptHandle);
    if (body === undefined) {
      throw new MessagingError(
        `No pending message for receipt handle: ${JSON.stringify(receiptHandle)}. ` +
          "Call receive() first and use the returned receiptHandle.",
      );
    }
    // Resolve the DLQ URL OUTSIDE the try/finally: a resolution failure must
    // not clear the pending body, so the caller can retry. Mirrors Python
    // (sqs.py:298-311) where _resolve_dlq_url runs before the try/finally.
    let dlqUrl: string;
    try {
      dlqUrl = await this.resolveDlqUrl(client, sdk);
    } catch (err) {
      throw this.mapError(err);
    }
    try {
      await client.send(
        new sdk.SendMessageCommand({
          QueueUrl: dlqUrl,
          MessageBody: body,
          MessageAttributes: {
            DeadLetterReason: { DataType: "String", StringValue: reason },
          },
        }),
      );
      await client.send(
        new sdk.DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
    } catch (err) {
      throw this.mapError(err);
    } finally {
      this.pending.delete(receiptHandle);
    }
  }

  async getQueueDepth(): Promise<number> {
    const client = await this.ensureClient();
    const sdk = await loadOptional<SqsModule>(SQS_PACKAGE, PROVIDER);
    try {
      const response: GetQueueAttributesCommandOutput = await client.send(
        new sdk.GetQueueAttributesCommand({
          QueueUrl: this.queueUrl,
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
      );
      const raw = response.Attributes?.ApproximateNumberOfMessages;
      const depth = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (Number.isNaN(depth)) {
        // Python (sqs.py:320) indexes Attributes["ApproximateNumberOfMessages"]
        // directly and raises KeyError when it is absent; surface a domain error
        // rather than returning NaN.
        throw new MessagingError(
          `SQS did not return ApproximateNumberOfMessages for ${this.queueUrl}`,
        );
      }
      return depth;
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /** Return the configured DLQ URL, deriving it from RedrivePolicy if needed. */
  private async resolveDlqUrl(client: SQSClient, sdk: SqsModule): Promise<string> {
    if (this.dlqUrl !== undefined) {
      return this.dlqUrl;
    }
    const response: GetQueueAttributesCommandOutput = await client.send(
      new sdk.GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: ["RedrivePolicy"],
      }),
    );
    const redrive = response.Attributes?.RedrivePolicy;
    if (!redrive) {
      throw new MessagingError(
        `No dead-letter queue configured for ${this.queueUrl}. Pass dlqUrl ` +
          "when constructing the backend, or set a RedrivePolicy on the queue.",
      );
    }
    const targetArn = (JSON.parse(redrive) as { deadLetterTargetArn: string }).deadLetterTargetArn;
    const dlqName = targetArn.slice(targetArn.lastIndexOf(":") + 1);
    const urlResponse: GetQueueUrlCommandOutput = await client.send(
      new sdk.GetQueueUrlCommand({ QueueName: dlqName }),
    );
    this.dlqUrl = urlResponse.QueueUrl ?? "";
    return this.dlqUrl;
  }

  async purge(): Promise<void> {
    const client = await this.ensureClient();
    const sdk = await loadOptional<SqsModule>(SQS_PACKAGE, PROVIDER);
    try {
      await client.send(new sdk.PurgeQueueCommand({ QueueUrl: this.queueUrl }));
      this.pending.clear();
    } catch (err) {
      throw this.mapError(err);
    }
  }

  override async healthCheck(): Promise<boolean> {
    try {
      const client = await this.ensureClient();
      const sdk = await loadOptional<SqsModule>(SQS_PACKAGE, PROVIDER);
      await client.send(
        new sdk.GetQueueAttributesCommand({
          QueueUrl: this.queueUrl,
          AttributeNames: ["QueueArn"],
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  override async close(): Promise<void> {
    this.pending.clear();
    if (this.client !== undefined) {
      const client = this.client;
      this.client = undefined;
      this.clientPromise = undefined;
      client.destroy();
    }
  }

  /** Translate an SQS SDK error into the cloudrift error tree (with `cause`). */
  private mapError(err: unknown): Error {
    if (err instanceof MessagingError) {
      return err;
    }
    const code = errorCode(err);
    if (code === "AWS.SimpleQueueService.NonExistentQueue" || code === "QueueDoesNotExist") {
      return new QueueNotFoundError(`Queue not found: ${this.queueUrl}`, {
        cause: err,
      });
    }
    if (
      code === "SendMessageBatchRequestEntry.SendMessageBatchRequestEntryId" ||
      code === "InvalidMessageContents"
    ) {
      return new MessageSendError(errorMessage(err), { cause: err });
    }
    return new MessagingError(errorMessage(err), { cause: err });
  }
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const named = (err as { name?: unknown }).name;
  if (typeof named === "string") {
    return named;
  }
  const code = (err as { Code?: unknown }).Code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
