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
import { awsServiceEnabled, env, liveLog, requireEnv, uniqueName } from "./env.js";

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
  const log = liveLog("aws:s3");
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
      log.step("using provided bucket", { bucket, prefix: PREFIX });
    } else {
      bucket = uniqueName("bucket");
      log.step("creating bucket", { bucket });
      await rawClient.send(new CreateBucketCommand({ Bucket: bucket }));
      createdBucket = true;
      log.step("created bucket", { bucket });
    }
    log.step("initializing backend", { provider: "s3", bucket });
    backend = await getStorage("s3", { ...awsAuthOptions(), bucket });
  });

  afterAll(async () => {
    try {
      await backend?.close();
      log.step("closed backend", { bucket });
    } catch (err) {
      log.warn("backend close failed", err, { bucket });
    }
    try {
      if (createdBucket && rawClient) {
        // Empty then delete a bucket WE created.
        let token: string | undefined;
        let deletedObjects = 0;
        do {
          const page = await rawClient.send(
            new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
          );
          const objects = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
          if (objects.length > 0) {
            await rawClient.send(
              new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
            );
            deletedObjects += objects.length;
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token);
        await rawClient.send(new DeleteBucketCommand({ Bucket: bucket }));
        log.step("deleted created bucket", { bucket, deletedObjects });
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
        log.step("cleaned provided bucket prefix", {
          bucket,
          prefix: PREFIX,
          deletedObjects: objects.length,
        });
      }
    } catch (err) {
      log.warn("cleanup failed", err, { bucket, prefix: PREFIX });
    } finally {
      rawClient?.destroy();
    }
  });

  it("uploads, reads back, lists, and deletes an object", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    log.step("uploading object", { bucket, key });
    await b.upload(key, payload, "text/plain");
    expect(await b.exists(key)).toBe(true);
    log.step("uploaded object", { bucket, key });

    const downloaded = await b.download(key);
    expect(downloaded.equals(payload)).toBe(true);
    log.step("downloaded object", { bucket, key, bytes: downloaded.length });

    const listed = await b.list(PREFIX);
    expect(listed).toContain(key);
    log.step("listed prefix", { bucket, prefix: PREFIX, count: listed.length });

    await b.delete(key);
    expect(await b.exists(key)).toBe(false);
    log.step("deleted object", { bucket, key });
  });
});

/* ================================================================== */
/* SQS                                                                */
/* ================================================================== */

describe.skipIf(!SQS_PRESENT)("AWS SQS live lifecycle", () => {
  const log = liveLog("aws:sqs");
  let queueUrl: string;
  let createdQueue = false;
  let rawClient: SQSClient | undefined;
  let backend: Awaited<ReturnType<typeof getQueue>> | undefined;

  beforeAll(async () => {
    const provided = env("CLOUDRIFT_LIVE_AWS_QUEUE_URL");
    if (provided !== undefined) {
      queueUrl = provided;
      log.step("using provided queue", { queueUrl });
    } else {
      rawClient = new SQSClient(awsClientConfig());
      const queueName = uniqueName("queue");
      log.step("creating queue", { queueName });
      const res = await rawClient.send(new CreateQueueCommand({ QueueName: queueName }));
      queueUrl = res.QueueUrl!;
      createdQueue = true;
      log.step("created queue", { queueName, queueUrl });
    }
    log.step("initializing backend", { provider: "sqs", queueUrl });
    backend = await getQueue("sqs", { ...awsAuthOptions(), queueUrl });
  });

  afterAll(async () => {
    try {
      await backend?.close();
      log.step("closed backend", { queueUrl });
    } catch (err) {
      log.warn("backend close failed", err, { queueUrl });
    }
    try {
      // Never purge an env-provided queue; only delete one WE created.
      if (createdQueue && rawClient) {
        await rawClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        log.step("deleted created queue", { queueUrl });
      } else {
        log.step("left provided queue intact", { queueUrl });
      }
    } catch (err) {
      log.warn("cleanup failed", err, { queueUrl });
    } finally {
      rawClient?.destroy();
    }
  });

  it("sends, receives (long-poll), acknowledges, and is healthy", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    const marker = uniqueName("msg");
    log.step("sending message", { queueUrl, marker });
    await b.send({ marker, n: 42 });

    // Bounded long-poll via the API's own WaitTimeSeconds (no manual polling).
    log.step("receiving message", { queueUrl, waitSeconds: 20 });
    const received = await b.receive(1, 20);
    expect(received.length).toBeGreaterThanOrEqual(1);
    const msg = received[0];
    expect(msg.body).toEqual({ marker, n: 42 });
    log.step("received message", { queueUrl, marker, count: received.length });

    await b.delete(msg.receiptHandle);
    log.step("acknowledged message", { queueUrl, marker });
    expect(await b.healthCheck()).toBe(true);
    log.step("health check passed", { queueUrl });
  });
});

/* ================================================================== */
/* SNS                                                                */
/* ================================================================== */

describe.skipIf(!SNS_PRESENT)("AWS SNS live lifecycle", () => {
  const log = liveLog("aws:sns");
  let topicArn: string;
  let createdTopic = false;
  let rawClient: SNSClient | undefined;
  let backend: Awaited<ReturnType<typeof getPubsub>> | undefined;

  beforeAll(async () => {
    const provided = env("CLOUDRIFT_LIVE_AWS_TOPIC_ARN");
    if (provided !== undefined) {
      topicArn = provided;
      log.step("using provided topic", { topicArn });
    } else {
      rawClient = new SNSClient(awsClientConfig());
      const topicName = uniqueName("topic");
      log.step("creating topic", { topicName });
      const res = await rawClient.send(new CreateTopicCommand({ Name: topicName }));
      topicArn = res.TopicArn!;
      createdTopic = true;
      log.step("created topic", { topicName, topicArn });
    }
    log.step("initializing backend", { provider: "sns" });
    backend = await getPubsub("sns", awsAuthOptions());
  });

  afterAll(async () => {
    try {
      await backend?.close();
      log.step("closed backend", { topicArn });
    } catch (err) {
      log.warn("backend close failed", err, { topicArn });
    }
    try {
      if (createdTopic && rawClient) {
        await rawClient.send(new DeleteTopicCommand({ TopicArn: topicArn }));
        log.step("deleted created topic", { topicArn });
      } else {
        log.step("left provided topic intact", { topicArn });
      }
    } catch (err) {
      log.warn("cleanup failed", err, { topicArn });
    } finally {
      rawClient?.destroy();
    }
  });

  it("publishes a single message and a batch, and is healthy", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    log.step("publishing message", { topicArn });
    const id = await b.publish(topicArn, "cloudrift-live-sns");
    expect(id).toBeTruthy();
    log.step("published message", { topicArn, messageId: id });

    log.step("publishing batch", { topicArn, count: 2 });
    const ids = await b.publishBatch(topicArn, [{ message: "one" }, { message: "two" }]);
    expect(ids).toHaveLength(2);
    log.step("published batch", { topicArn, count: ids.length });

    expect(await b.healthCheck()).toBe(true);
    log.step("health check passed", { topicArn });
  });
});

/* ================================================================== */
/* Secrets Manager                                                    */
/* ================================================================== */

describe.skipIf(!SECRETS_PRESENT)("AWS Secrets Manager live lifecycle", () => {
  const log = liveLog("aws:secrets");
  const PREFIX = uniqueName("secret");
  const name = PREFIX;
  let backend: Awaited<ReturnType<typeof getSecrets>> | undefined;

  beforeAll(async () => {
    log.step("initializing backend", { provider: "aws_secrets_manager", name });
    backend = await getSecrets("aws_secrets_manager", awsAuthOptions());
  });

  afterAll(async () => {
    try {
      // Backend force-deletes (ForceDeleteWithoutRecovery). Always safe — we
      // only ever create uniquely-named secrets here.
      await backend?.deleteSecret(name);
      log.step("deleted secret", { name });
    } catch (err) {
      log.warn("cleanup failed", err, { name });
    }
    try {
      await backend?.close();
      log.step("closed backend", { name });
    } catch (err) {
      log.warn("backend close failed", err, { name });
    }
  });

  it("sets, reads back, and lists a secret by prefix", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    const value = "cloudrift-live-secret-value";
    log.step("setting secret", { name });
    await b.setSecret(name, value);
    expect(await b.getSecret(name)).toBe(value);
    log.step("read secret", { name });

    const listed = await b.listSecrets(PREFIX);
    expect(listed).toContain(name);
    log.step("listed secrets", { prefix: PREFIX, count: listed.length });
  });
});
