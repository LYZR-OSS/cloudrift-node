/**
 * AWS SNS pub/sub backend (`@aws-sdk/client-sns`).
 *
 * A single SNS client is created lazily on first use (promise-memoized) and
 * reused for the lifetime of the backend. Mirrors `cloudrift-py`'s
 * `cloudrift/pubsub/sns.py`.
 */

import type {
  SNSClient,
  SNSClientConfig,
  MessageAttributeValue,
  PublishBatchRequestEntry,
} from "@aws-sdk/client-sns";

import { PubSubError, PublishError, TopicNotFoundError } from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { PubSubBackend, type PubSubMessage } from "./base.js";

const SNS_PKG = "@aws-sdk/client-sns";
const PROVIDER = "sns";

/** Shape of the lazily-imported `@aws-sdk/client-sns` module. */
interface SNSModule {
  SNSClient: new (config: SNSClientConfig) => SNSClient;
  PublishCommand: new (input: Record<string, unknown>) => object;
  PublishBatchCommand: new (input: Record<string, unknown>) => object;
  ListTopicsCommand: new (input: Record<string, unknown>) => object;
}

/** Options shared across all SNS factory constructors. */
export interface SNSClientOptions {
  endpointUrl?: string;
  maxPoolConnections?: number;
  connectTimeout?: number;
  readTimeout?: number;
}

export interface SNSAccessKeyOptions extends SNSClientOptions {
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken?: string;
  region?: string;
}

export interface SNSIamRoleOptions extends SNSClientOptions {
  region?: string;
}

export interface SNSProfileOptions extends SNSClientOptions {
  profileName: string;
  region?: string;
}

interface SNSConfig {
  region: string;
  endpointUrl?: string;
  maxPoolConnections: number;
  connectTimeout: number;
  readTimeout: number;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  profile?: string;
}

function buildConfig(
  opts: SNSClientOptions,
): Pick<SNSConfig, "endpointUrl" | "maxPoolConnections" | "connectTimeout" | "readTimeout"> {
  return {
    endpointUrl: opts.endpointUrl,
    maxPoolConnections: opts.maxPoolConnections ?? 25,
    connectTimeout: opts.connectTimeout ?? 10,
    readTimeout: opts.readTimeout ?? 30,
  };
}

export class AWSSNSBackend extends PubSubBackend {
  private readonly config: SNSConfig;
  private mod: SNSModule | undefined;
  private client: SNSClient | undefined;
  private ensuring: Promise<SNSClient> | undefined;

  constructor(config: SNSConfig) {
    super();
    this.config = config;
  }

  // --------------------------------------------------------------------
  // Factory constructors
  // --------------------------------------------------------------------

  static fromAccessKey(opts: SNSAccessKeyOptions): AWSSNSBackend {
    return new AWSSNSBackend({
      ...buildConfig(opts),
      region: opts.region ?? "us-east-1",
      credentials: {
        accessKeyId: opts.awsAccessKeyId,
        secretAccessKey: opts.awsSecretAccessKey,
        sessionToken: opts.awsSessionToken,
      },
    });
  }

  static fromIamRole(opts: SNSIamRoleOptions = {}): AWSSNSBackend {
    return new AWSSNSBackend({
      ...buildConfig(opts),
      region: opts.region ?? "us-east-1",
    });
  }

  static fromProfile(opts: SNSProfileOptions): AWSSNSBackend {
    return new AWSSNSBackend({
      ...buildConfig(opts),
      region: opts.region ?? "us-east-1",
      profile: opts.profileName,
    });
  }

  // --------------------------------------------------------------------
  // Lazy client init
  // --------------------------------------------------------------------

  private async ensure(): Promise<SNSClient> {
    if (this.client !== undefined) {
      return this.client;
    }
    if (this.ensuring === undefined) {
      this.ensuring = this.createClient();
    }
    try {
      this.client = await this.ensuring;
      return this.client;
    } catch (err) {
      this.ensuring = undefined;
      this.mod = undefined;
      throw err;
    }
  }

  private async createClient(): Promise<SNSClient> {
    const mod = await loadOptional<SNSModule>(SNS_PKG, PROVIDER);
    this.mod = mod;
    const cfg: SNSClientConfig = {
      region: this.config.region,
      maxAttempts: undefined,
      requestHandler: {
        connectionTimeout: this.config.connectTimeout * 1000,
        requestTimeout: this.config.readTimeout * 1000,
        httpsAgent: { maxSockets: this.config.maxPoolConnections },
      } as unknown as SNSClientConfig["requestHandler"],
    };
    if (this.config.endpointUrl !== undefined) {
      cfg.endpoint = this.config.endpointUrl;
    }
    if (this.config.credentials !== undefined) {
      cfg.credentials = {
        accessKeyId: this.config.credentials.accessKeyId,
        secretAccessKey: this.config.credentials.secretAccessKey,
        sessionToken: this.config.credentials.sessionToken,
      };
    } else if (this.config.profile !== undefined) {
      const credsMod = await loadOptional<typeof import("@aws-sdk/credential-providers")>(
        "@aws-sdk/credential-providers",
        PROVIDER,
      );
      cfg.credentials = credsMod.fromIni({ profile: this.config.profile });
    }
    return new mod.SNSClient(cfg);
  }

  override async close(): Promise<void> {
    if (this.client !== undefined) {
      this.client.destroy();
      this.client = undefined;
    }
    this.ensuring = undefined;
  }

  // --------------------------------------------------------------------
  // PubSubBackend implementation
  // --------------------------------------------------------------------

  override async publish(
    topic: string,
    message: string,
    attributes?: Record<string, string>,
  ): Promise<string> {
    const client = await this.ensure();
    const mod = this.mod!;
    const input: Record<string, unknown> = { TopicArn: topic, Message: message };
    if (attributes !== undefined && Object.keys(attributes).length > 0) {
      input.MessageAttributes = toMessageAttributes(attributes);
    }
    try {
      const response = (await client.send(new mod.PublishCommand(input) as never)) as {
        MessageId?: string;
      };
      return response.MessageId ?? "";
    } catch (err) {
      throw this.translate(err, topic);
    }
  }

  override async publishBatch(topic: string, messages: PubSubMessage[]): Promise<string[]> {
    const client = await this.ensure();
    const mod = this.mod!;
    const allIds: string[] = [];
    // SNS batch limit is 10.
    for (let i = 0; i < messages.length; i += 10) {
      const chunk = messages.slice(i, i + 10);
      const entries: PublishBatchRequestEntry[] = chunk.map((msg, j) => {
        const entry: PublishBatchRequestEntry = {
          Id: String(j),
          Message: msg.message ?? JSON.stringify(msg),
        };
        if (msg.attributes !== undefined && Object.keys(msg.attributes).length > 0) {
          entry.MessageAttributes = toMessageAttributes(msg.attributes);
        }
        return entry;
      });
      try {
        const response = (await client.send(
          new mod.PublishBatchCommand({
            TopicArn: topic,
            PublishBatchRequestEntries: entries,
          }) as never,
        )) as {
          Successful?: Array<{ MessageId?: string }>;
          Failed?: Array<{ Id?: string }>;
        };
        if (response.Failed !== undefined && response.Failed.length > 0) {
          const failed = response.Failed.map((f) => f.Id);
          throw new PublishError(`Failed to publish messages: ${JSON.stringify(failed)}`);
        }
        for (const s of response.Successful ?? []) {
          allIds.push(s.MessageId ?? "");
        }
      } catch (err) {
        if (err instanceof PublishError) {
          throw err;
        }
        throw this.translate(err, topic);
      }
    }
    return allIds;
  }

  override async healthCheck(): Promise<boolean> {
    try {
      const client = await this.ensure();
      const mod = this.mod!;
      await client.send(new mod.ListTopicsCommand({ NextToken: "" }) as never);
      return true;
    } catch {
      return false;
    }
  }

  private translate(err: unknown, topic: string): Error {
    const code = errorCode(err);
    if (code === "NotFound" || code === "NotFoundException") {
      return new TopicNotFoundError(`Topic not found: ${topic}`, { cause: err });
    }
    if (
      code === "AuthorizationError" ||
      code === "AuthorizationErrorException" ||
      code === "AccessDenied"
    ) {
      return new PubSubError(`Access denied for topic: ${topic}`, { cause: err });
    }
    return new PubSubError(errorMessage(err), { cause: err });
  }
}

function toMessageAttributes(
  attributes: Record<string, string>,
): Record<string, MessageAttributeValue> {
  const out: Record<string, MessageAttributeValue> = {};
  for (const [k, v] of Object.entries(attributes)) {
    out[k] = { DataType: "String", StringValue: String(v) };
  }
  return out;
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const name = (err as { name?: unknown }).name;
  if (typeof name === "string") {
    return name;
  }
  // AWS SDK v3 surfaces the service error code on `Code`; botocore-style
  // lowercase `code` is also tolerated for compatibility.
  const upperCode = (err as { Code?: unknown }).Code;
  if (typeof upperCode === "string") {
    return upperCode;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
