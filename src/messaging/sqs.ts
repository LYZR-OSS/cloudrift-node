import type {
  SQSClient,
  SQSClientConfig,
  SendMessageCommandOutput,
  SendMessageBatchCommandOutput,
  ReceiveMessageCommandOutput,
} from "@aws-sdk/client-sqs";

import { loadOptional } from "../core/lazy.js";
import { MessageSendError, MessagingError, QueueNotFoundError } from "../core/errors.js";
import { MessagingBackend, type Message } from "./base.js";

const PROVIDER = "sqs";
const SQS_PACKAGE = "@aws-sdk/client-sqs";

/** Shape of the lazily-imported `@aws-sdk/client-sqs` module. */
type SqsModule = typeof import("@aws-sdk/client-sqs");

/** AWS auth/transport configuration captured at construction time. */
export interface SqsBackendConfig {
  endpointUrl?: string;
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
  private clientPromise: Promise<SQSClient> | undefined;
  private client: SQSClient | undefined;

  private constructor(init: SqsInit) {
    super();
    this.queueUrl = init.queueUrl;
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

  async send(message: Record<string, unknown>, delay = 0): Promise<string> {
    const client = await this.ensure();
    const sdk = await loadOptional<SqsModule>(SQS_PACKAGE, PROVIDER);
    try {
      const response: SendMessageCommandOutput = await client.send(
        new sdk.SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(message),
          DelaySeconds: delay,
        }),
      );
      return response.MessageId ?? "";
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async sendBatch(messages: Array<Record<string, unknown>>): Promise<string[]> {
    const client = await this.ensure();
    const sdk = await loadOptional<SqsModule>(SQS_PACKAGE, PROVIDER);
    const ids: string[] = [];
    try {
      for (let offset = 0; offset < messages.length; offset += SQS_SEND_BATCH_LIMIT) {
        const chunk = messages.slice(offset, offset + SQS_SEND_BATCH_LIMIT);
        const entries = chunk.map((msg, i) => ({
          Id: String(offset + i),
          MessageBody: JSON.stringify(msg),
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

  async receive(maxMessages = 1, waitTime = 0): Promise<Message[]> {
    const client = await this.ensure();
    const sdk = await loadOptional<SqsModule>(SQS_PACKAGE, PROVIDER);
    try {
      const response: ReceiveMessageCommandOutput = await client.send(
        new sdk.ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: Math.min(maxMessages, 10),
          WaitTimeSeconds: waitTime,
          AttributeNames: ["All"],
        }),
      );
      return (response.Messages ?? []).map((m) => ({
        id: m.MessageId ?? "",
        body: JSON.parse(m.Body ?? "{}") as Record<string, unknown>,
        receiptHandle: m.ReceiptHandle ?? "",
        attributes: (m.Attributes ?? {}) as Record<string, unknown>,
      }));
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async delete(receiptHandle: string): Promise<void> {
    const client = await this.ensure();
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
    }
  }

  async purge(): Promise<void> {
    const client = await this.ensure();
    const sdk = await loadOptional<SqsModule>(SQS_PACKAGE, PROVIDER);
    try {
      await client.send(new sdk.PurgeQueueCommand({ QueueUrl: this.queueUrl }));
    } catch (err) {
      throw this.mapError(err);
    }
  }

  override async healthCheck(): Promise<boolean> {
    try {
      const client = await this.ensure();
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
    if (this.client !== undefined) {
      this.client.destroy();
      this.client = undefined;
      this.clientPromise = undefined;
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
