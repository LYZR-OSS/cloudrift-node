/**
 * Shared harness for the AWS emulator lane.
 *
 * Two responsibilities:
 *  1. `awsOptions()` returns the literal option object the cloudrift public
 *     factories accept for access-key auth against a custom endpoint. All tests
 *     must drive the SDK through the public factories (`getStorage`,
 *     `getSecrets`, `getQueue`, `getPubsub`) using this shape — never by
 *     constructing backends from raw SDK clients.
 *  2. Provisioning helpers (`createBucket`, `createQueue`, ...) use raw AWS SDK
 *     v3 clients pointed at the same LocalStack endpoint. These are setup/teardown
 *     plumbing, not the system under test.
 *
 * The endpoint is supplied by `tests/aws-emulator/globalSetup.ts`, which starts
 * one LocalStack container and publishes its URL via vitest's `provide()`. We
 * read it here with `inject()`.
 */

import { inject } from "vitest";

import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import {
  SNSClient,
  CreateTopicCommand,
  DeleteTopicCommand,
  SubscribeCommand,
} from "@aws-sdk/client-sns";

export const REGION = "us-east-1";

/** LocalStack only validates that *some* credentials are present, not which. */
const ACCESS_KEY_ID = "test";
const SECRET_ACCESS_KEY = "test";

/**
 * Resolve the LocalStack endpoint published by the global setup, normalized to a
 * literal IP host so it works uniformly across every AWS service.
 *
 * The cloudrift S3 backend intentionally does NOT force path-style addressing
 * (it mirrors the Python adapter, which relies on the SDK's default "auto"
 * addressing). Against a domain-style endpoint such as `http://localhost:PORT`
 * the AWS SDK builds a virtual-host URL `http://<bucket>.localhost:PORT`, which
 * does not resolve. When the endpoint host is an IP literal, the S3 endpoint
 * ruleset is required to fall back to path-style, so we rewrite the host to
 * `127.0.0.1`. An IP host also avoids LocalStack's hostname-based service
 * routing (a `s3.`-prefixed host would misroute Secrets Manager calls to S3), so
 * the same endpoint is valid for S3, Secrets Manager, SQS, and SNS.
 */
export function endpoint(): string {
  const uri = new URL(inject("localstackEndpoint"));
  uri.hostname = "127.0.0.1";
  return uri.toString().replace(/\/$/, "");
}

/**
 * Access-key auth options accepted by every cloudrift AWS factory.
 *
 * VERIFIED against the factory option interfaces in src/:
 *   - storage/s3.ts `AwsAccessKeyOptions`
 *   - secrets/awsSecretsManager.ts `AwsAccessKeyOptions`
 *   - messaging/sqs.ts `SqsAccessKeyOptions`
 *   - pubsub/sns.ts `SNSAccessKeyOptions`
 *
 * All four take `awsAccessKeyId` / `awsSecretAccessKey` / `region` and a flat
 * `endpointUrl` (NOT a nested `clientOptions.endpointUrl`). Each factory routes
 * to its `fromAccessKey` constructor because `awsAccessKeyId` is present. Storage
 * additionally requires a `bucket` key, which callers spread in themselves.
 */
export function awsOptions(): {
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  region: string;
  endpointUrl: string;
} {
  return {
    awsAccessKeyId: ACCESS_KEY_ID,
    awsSecretAccessKey: SECRET_ACCESS_KEY,
    region: REGION,
    endpointUrl: endpoint(),
  };
}

let counter = 0;

/** Unique, lowercase, S3-safe resource name for a given kind. */
export function uniqueName(kind: string): string {
  counter += 1;
  return `crift-${kind}-${Date.now().toString()}-${counter.toString()}`.toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Raw SDK clients for provisioning (setup/teardown only)             */
/* ------------------------------------------------------------------ */

function rawConfig() {
  return {
    region: REGION,
    endpoint: endpoint(),
    credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    // S3 against LocalStack is most reliable with path-style addressing.
    forcePathStyle: true,
  };
}

function s3(): S3Client {
  return new S3Client(rawConfig());
}

function sqs(): SQSClient {
  return new SQSClient(rawConfig());
}

function sns(): SNSClient {
  return new SNSClient(rawConfig());
}

export async function createBucket(name: string): Promise<void> {
  const client = s3();
  try {
    await client.send(new CreateBucketCommand({ Bucket: name }));
  } finally {
    client.destroy();
  }
}

export async function emptyAndDeleteBucket(name: string): Promise<void> {
  const client = s3();
  try {
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: name, ContinuationToken: continuationToken }),
      );
      const objects = (page.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => k !== undefined)
        .map((Key) => ({ Key }));
      if (objects.length > 0) {
        await client.send(new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: objects } }));
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    await client.send(new DeleteBucketCommand({ Bucket: name }));
  } finally {
    client.destroy();
  }
}

export async function createQueue(name: string): Promise<string> {
  const client = sqs();
  try {
    const result = await client.send(new CreateQueueCommand({ QueueName: name }));
    if (!result.QueueUrl) {
      throw new Error(`CreateQueue returned no QueueUrl for ${name}`);
    }
    return result.QueueUrl;
  } finally {
    client.destroy();
  }
}

export async function deleteQueue(queueUrl: string): Promise<void> {
  const client = sqs();
  try {
    await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  } finally {
    client.destroy();
  }
}

export async function createTopic(name: string): Promise<string> {
  const client = sns();
  try {
    const result = await client.send(new CreateTopicCommand({ Name: name }));
    if (!result.TopicArn) {
      throw new Error(`CreateTopic returned no TopicArn for ${name}`);
    }
    return result.TopicArn;
  } finally {
    client.destroy();
  }
}

export async function deleteTopic(topicArn: string): Promise<void> {
  const client = sns();
  try {
    await client.send(new DeleteTopicCommand({ TopicArn: topicArn }));
  } finally {
    client.destroy();
  }
}

/**
 * Subscribe an SQS queue to an SNS topic with raw message delivery enabled, so
 * the queue receives the published payload verbatim (no SNS JSON envelope).
 * Returns the subscription ARN.
 */
export async function subscribeQueueToTopic(topicArn: string, queueUrl: string): Promise<string> {
  const sqsClient = sqs();
  const snsClient = sns();
  try {
    const attrs = await sqsClient.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }),
    );
    const queueArn = attrs.Attributes?.QueueArn;
    if (!queueArn) {
      throw new Error(`Could not resolve QueueArn for ${queueUrl}`);
    }
    const result = await snsClient.send(
      new SubscribeCommand({
        TopicArn: topicArn,
        Protocol: "sqs",
        Endpoint: queueArn,
        Attributes: { RawMessageDelivery: "true" },
        ReturnSubscriptionArn: true,
      }),
    );
    if (!result.SubscriptionArn) {
      throw new Error(`Subscribe returned no SubscriptionArn for ${topicArn}`);
    }
    return result.SubscriptionArn;
  } finally {
    sqsClient.destroy();
    snsClient.destroy();
  }
}
