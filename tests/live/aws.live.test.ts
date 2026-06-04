/**
 * AWS live lifecycle tests (S3, SQS, SNS, Secrets Manager).
 *
 * Gated on CLOUDRIFT_LIVE_TESTS=1 plus a region and one auth method. Resources
 * are created-if-permitted (raw SDK) unless a pre-provisioned override is set;
 * we only ever delete what WE created, and only prefix-scoped keys/messages on
 * env-provided resources. Cleanup runs in afterAll wrapped in try/catch so a
 * cleanup failure never masks a test failure.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { SQSClient, CreateQueueCommand, DeleteQueueCommand } from "@aws-sdk/client-sqs";
import { SNSClient, CreateTopicCommand, DeleteTopicCommand } from "@aws-sdk/client-sns";

import { getStorage, getQueue, getPubsub, getSecrets } from "../../src/index.js";
import { awsServiceEnabled, env, requireEnv, uniqueName } from "./env.js";

/* ------------------------------------------------------------------ */
/* Shared AWS auth resolution                                          */
/* ------------------------------------------------------------------ */

const REGION = env("CLOUDRIFT_LIVE_AWS_REGION");

/** Build the cloudrift factory auth options from env (access key or profile). */
function awsAuthOptions(): Record<string, unknown> {
  const accessKeyId = env("CLOUDRIFT_LIVE_AWS_ACCESS_KEY_ID");
  const secretAccessKey = env("CLOUDRIFT_LIVE_AWS_SECRET_ACCESS_KEY");
  const sessionToken = env("CLOUDRIFT_LIVE_AWS_SESSION_TOKEN");
  const profileName = env("CLOUDRIFT_LIVE_AWS_PROFILE");
  if (accessKeyId !== undefined && secretAccessKey !== undefined) {
    return {
      region: REGION,
      awsAccessKeyId: accessKeyId,
      awsSecretAccessKey: secretAccessKey,
      ...(sessionToken ? { awsSessionToken: sessionToken } : {}),
    };
  }
  return { region: REGION, profileName };
}

/** Build raw-SDK client config matching the same auth method. */
function awsClientConfig(): Record<string, unknown> {
  const accessKeyId = env("CLOUDRIFT_LIVE_AWS_ACCESS_KEY_ID");
  const secretAccessKey = env("CLOUDRIFT_LIVE_AWS_SECRET_ACCESS_KEY");
  const sessionToken = env("CLOUDRIFT_LIVE_AWS_SESSION_TOKEN");
  const config: Record<string, unknown> = { region: REGION };
  if (accessKeyId !== undefined && secretAccessKey !== undefined) {
    config.credentials = {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    };
  }
  // Profile credentials are picked up from the shared config file by the SDK's
  // default provider chain when AWS_PROFILE is set; here we rely on the ambient
  // environment, matching how the cloudrift profile factory resolves them.
  return config;
}

const AWS_AUTH_PRESENT =
  requireEnv([
    "CLOUDRIFT_LIVE_AWS_REGION",
    "CLOUDRIFT_LIVE_AWS_ACCESS_KEY_ID",
    "CLOUDRIFT_LIVE_AWS_SECRET_ACCESS_KEY",
  ]) || requireEnv(["CLOUDRIFT_LIVE_AWS_REGION", "CLOUDRIFT_LIVE_AWS_PROFILE"]);

/**
 * Per-service gates: a service runs only when auth is present AND it is enabled
 * by the optional CLOUDRIFT_LIVE_AWS_SERVICES allowlist (default = all enabled).
 * This lets partial-permission accounts SKIP services they cannot access
 * instead of FAILING at runtime.
 */
const S3_PRESENT = AWS_AUTH_PRESENT && awsServiceEnabled("s3");
const SQS_PRESENT = AWS_AUTH_PRESENT && awsServiceEnabled("sqs");
const SNS_PRESENT = AWS_AUTH_PRESENT && awsServiceEnabled("sns");
const SECRETS_PRESENT = AWS_AUTH_PRESENT && awsServiceEnabled("secrets");

/* ================================================================== */
/* S3                                                                 */
/* ================================================================== */

describe.skipIf(!S3_PRESENT)("AWS S3 live lifecycle", () => {
  const PREFIX = `${uniqueName("s3")}/`;
  const key = `${PREFIX}hello.txt`;
  const payload = Buffer.from("cloudrift-live-s3-payload", "utf8");

  let bucket: string;
  let createdBucket = false;
  let rawClient: S3Client | undefined;
  let backend: Awaited<ReturnType<typeof getStorage>> | undefined;

  beforeAll(async () => {
    const provided = env("CLOUDRIFT_LIVE_AWS_BUCKET");
    rawClient = new S3Client(awsClientConfig());
    if (provided !== undefined) {
      bucket = provided;
    } else {
      bucket = uniqueName("bucket");
      await rawClient.send(new CreateBucketCommand({ Bucket: bucket }));
      createdBucket = true;
    }
    backend = await getStorage("s3", { ...awsAuthOptions(), bucket });
  });

  afterAll(async () => {
    try {
      await backend?.close();
    } catch (err) {
      console.warn("[live s3] backend close failed:", err);
    }
    try {
      if (createdBucket && rawClient) {
        // Empty then delete a bucket WE created.
        let token: string | undefined;
        do {
          const page = await rawClient.send(
            new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
          );
          const objects = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
          if (objects.length > 0) {
            await rawClient.send(
              new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
            );
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token);
        await rawClient.send(new DeleteBucketCommand({ Bucket: bucket }));
      } else if (rawClient) {
        // Env-provided bucket: only delete our prefixed keys.
        const page = await rawClient.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX }),
        );
        const objects = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
        if (objects.length > 0) {
          await rawClient.send(
            new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
          );
        }
      }
    } catch (err) {
      console.warn("[live s3] cleanup failed:", err);
    } finally {
      rawClient?.destroy();
    }
  });

  it("uploads, reads back, lists, and deletes an object", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    await b.upload(key, payload, "text/plain");
    expect(await b.exists(key)).toBe(true);

    const downloaded = await b.download(key);
    expect(downloaded.equals(payload)).toBe(true);

    const listed = await b.list(PREFIX);
    expect(listed).toContain(key);

    await b.delete(key);
    expect(await b.exists(key)).toBe(false);
  });
});

/* ================================================================== */
/* SQS                                                                */
/* ================================================================== */

describe.skipIf(!SQS_PRESENT)("AWS SQS live lifecycle", () => {
  let queueUrl: string;
  let createdQueue = false;
  let rawClient: SQSClient | undefined;
  let backend: Awaited<ReturnType<typeof getQueue>> | undefined;

  beforeAll(async () => {
    const provided = env("CLOUDRIFT_LIVE_AWS_QUEUE_URL");
    if (provided !== undefined) {
      queueUrl = provided;
    } else {
      rawClient = new SQSClient(awsClientConfig());
      const res = await rawClient.send(new CreateQueueCommand({ QueueName: uniqueName("queue") }));
      queueUrl = res.QueueUrl!;
      createdQueue = true;
    }
    backend = await getQueue("sqs", { ...awsAuthOptions(), queueUrl });
  });

  afterAll(async () => {
    try {
      await backend?.close();
    } catch (err) {
      console.warn("[live sqs] backend close failed:", err);
    }
    try {
      // Never purge an env-provided queue; only delete one WE created.
      if (createdQueue && rawClient) {
        await rawClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      }
    } catch (err) {
      console.warn("[live sqs] cleanup failed:", err);
    } finally {
      rawClient?.destroy();
    }
  });

  it("sends, receives (long-poll), acknowledges, and is healthy", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    const marker = uniqueName("msg");
    await b.send({ marker, n: 42 });

    // Bounded long-poll via the API's own WaitTimeSeconds (no manual polling).
    const received = await b.receive(1, 20);
    expect(received.length).toBeGreaterThanOrEqual(1);
    const msg = received[0];
    expect(msg.body).toEqual({ marker, n: 42 });

    await b.delete(msg.receiptHandle);
    expect(await b.healthCheck()).toBe(true);
  });
});

/* ================================================================== */
/* SNS                                                                */
/* ================================================================== */

describe.skipIf(!SNS_PRESENT)("AWS SNS live lifecycle", () => {
  let topicArn: string;
  let createdTopic = false;
  let rawClient: SNSClient | undefined;
  let backend: Awaited<ReturnType<typeof getPubsub>> | undefined;

  beforeAll(async () => {
    const provided = env("CLOUDRIFT_LIVE_AWS_TOPIC_ARN");
    if (provided !== undefined) {
      topicArn = provided;
    } else {
      rawClient = new SNSClient(awsClientConfig());
      const res = await rawClient.send(new CreateTopicCommand({ Name: uniqueName("topic") }));
      topicArn = res.TopicArn!;
      createdTopic = true;
    }
    backend = await getPubsub("sns", awsAuthOptions());
  });

  afterAll(async () => {
    try {
      await backend?.close();
    } catch (err) {
      console.warn("[live sns] backend close failed:", err);
    }
    try {
      if (createdTopic && rawClient) {
        await rawClient.send(new DeleteTopicCommand({ TopicArn: topicArn }));
      }
    } catch (err) {
      console.warn("[live sns] cleanup failed:", err);
    } finally {
      rawClient?.destroy();
    }
  });

  it("publishes a single message and a batch, and is healthy", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    const id = await b.publish(topicArn, "cloudrift-live-sns");
    expect(id).toBeTruthy();

    const ids = await b.publishBatch(topicArn, [{ message: "one" }, { message: "two" }]);
    expect(ids).toHaveLength(2);

    expect(await b.healthCheck()).toBe(true);
  });
});

/* ================================================================== */
/* Secrets Manager                                                    */
/* ================================================================== */

describe.skipIf(!SECRETS_PRESENT)("AWS Secrets Manager live lifecycle", () => {
  const PREFIX = uniqueName("secret");
  const name = PREFIX;
  let backend: Awaited<ReturnType<typeof getSecrets>> | undefined;

  beforeAll(async () => {
    backend = await getSecrets("aws_secrets_manager", awsAuthOptions());
  });

  afterAll(async () => {
    try {
      // Backend force-deletes (ForceDeleteWithoutRecovery). Always safe — we
      // only ever create uniquely-named secrets here.
      await backend?.deleteSecret(name);
    } catch (err) {
      console.warn("[live secrets] cleanup failed:", err);
    }
    try {
      await backend?.close();
    } catch (err) {
      console.warn("[live secrets] backend close failed:", err);
    }
  });

  it("sets, reads back, and lists a secret by prefix", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    const value = "cloudrift-live-secret-value";
    await b.setSecret(name, value);
    expect(await b.getSecret(name)).toBe(value);

    const listed = await b.listSecrets(PREFIX);
    expect(listed).toContain(name);
  });
});
