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
import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { SNSClient, CreateTopicCommand, DeleteTopicCommand } from "@aws-sdk/client-sns";

import { getStorage, getQueue, getPubsub, getSecrets } from "../../src/index.js";
import type { Message } from "../../src/index.js";
import {
  awsServiceEnabled,
  env,
  getSqsExtrasConfig,
  liveLog,
  requireEnv,
  uniqueName,
} from "./env.js";

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

/**
 * Poll `getQueueDepth()` until it equals `target` or the deadline passes, then
 * return the last observed depth for the caller to assert on.
 *
 * SQS `ApproximateNumberOfMessages` is eventually consistent in BOTH directions:
 * it lags behind a burst of sends (a read right after sending can still see 0)
 * and behind consumption. A single read is therefore inherently racy; polling to
 * convergence is the correct way to observe steady state without flaking.
 */
async function pollQueueDepth(
  backend: { getQueueDepth: () => Promise<number> },
  target: number,
  timeoutMs = 30_000,
  intervalMs = 1_000,
): Promise<number> {
  const start = Date.now();
  let depth = await backend.getQueueDepth();
  while (depth !== target && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    depth = await backend.getQueueDepth();
  }
  return depth;
}

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

/* ================================================================== */
/* SQS FIFO (ordering + dedup)                                        */
/* ================================================================== */

describe.skipIf(!SQS_PRESENT)("AWS SQS FIFO live lifecycle", () => {
  const log = liveLog("aws:sqs:fifo");
  let queueUrl: string;
  let createdQueue = false;
  let rawClient: SQSClient | undefined;
  let backend: Awaited<ReturnType<typeof getQueue>> | undefined;

  beforeAll(async () => {
    const provided = getSqsExtrasConfig().fifoQueueUrl;
    rawClient = new SQSClient(awsClientConfig());
    if (provided !== undefined) {
      queueUrl = provided;
      log.step("using provided FIFO queue", { queueUrl });
    } else {
      // FIFO queue names MUST end with ".fifo".
      const queueName = `${uniqueName("fifo")}.fifo`;
      log.step("creating FIFO queue", { queueName });
      const res = await rawClient.send(
        new CreateQueueCommand({
          QueueName: queueName,
          Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
        }),
      );
      queueUrl = res.QueueUrl!;
      createdQueue = true;
      log.step("created FIFO queue", { queueName, queueUrl });
    }
    // The backend keys FIFO behavior off the ".fifo" URL suffix.
    expect(queueUrl.endsWith(".fifo")).toBe(true);
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
      if (createdQueue && rawClient) {
        await rawClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        log.step("deleted created FIFO queue", { queueUrl });
      } else {
        log.step("left provided FIFO queue intact", { queueUrl });
      }
    } catch (err) {
      log.warn("cleanup failed", err, { queueUrl });
    } finally {
      rawClient?.destroy();
    }
  });

  it("sends with groupId/dedupId, suppresses duplicates, and preserves order", async () => {
    expect(backend).toBeDefined();
    const b = backend!;
    const groupId = uniqueName("grp");

    // (1) groupId/dedupId round-trip: receive returns both attributes.
    const dedupId = uniqueName("dedup");
    const marker = uniqueName("fifo-msg");
    log.step("sending FIFO message", { queueUrl, groupId, dedupId, marker });
    await b.send({ marker, seq: 0 }, 0, { groupId, dedupId });

    const first = await b.receive(1, 20);
    expect(first.length).toBeGreaterThanOrEqual(1);
    const firstMsg = first[0];
    expect(firstMsg.body).toEqual({ marker, seq: 0 });
    expect(firstMsg.groupId).toBe(groupId);
    expect(firstMsg.dedupId).toBe(dedupId);
    log.step("received FIFO message with attributes", { groupId, dedupId });
    await b.delete(firstMsg.receiptHandle);

    // (2) Deduplication: the same dedupId sent twice is delivered once. Use a
    // fresh dedupId/group so this is isolated from the round-trip above.
    const dupGroup = uniqueName("grp-dup");
    const dupId = uniqueName("dedup-dup");
    const dupMarker = uniqueName("fifo-dup");
    log.step("sending duplicate dedupId twice", { dupGroup, dupId });
    await b.send({ marker: dupMarker, copy: 1 }, 0, { groupId: dupGroup, dedupId: dupId });
    await b.send({ marker: dupMarker, copy: 2 }, 0, { groupId: dupGroup, dedupId: dupId });

    // Drain up to a few times; only ONE copy of dupMarker may ever appear.
    const dupSeen: Message[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const batch = await b.receive(10, 5);
      for (const m of batch) {
        if (m.body.marker === dupMarker) {
          dupSeen.push(m);
        }
        await b.delete(m.receiptHandle);
      }
      if (dupSeen.length >= 1) {
        break;
      }
    }
    expect(dupSeen.length).toBe(1);
    log.step("dedup suppressed duplicate", { received: dupSeen.length });

    // (3) Ordering within a group: messages in one group are received in send
    // order. Use a fresh group so prior messages do not interleave.
    const orderGroup = uniqueName("grp-order");
    const orderMarker = uniqueName("fifo-order");
    const total = 3;
    for (let seq = 0; seq < total; seq += 1) {
      await b.send({ marker: orderMarker, seq }, 0, {
        groupId: orderGroup,
        dedupId: `${orderMarker}-${seq}`,
      });
    }
    log.step("sent ordered batch", { orderGroup, total });

    const ordered: number[] = [];
    for (let attempt = 0; attempt < 5 && ordered.length < total; attempt += 1) {
      const batch = await b.receive(10, 10);
      for (const m of batch) {
        if (m.body.marker === orderMarker) {
          expect(m.groupId).toBe(orderGroup);
          ordered.push(m.body.seq as number);
        }
        await b.delete(m.receiptHandle);
      }
    }
    expect(ordered).toEqual([0, 1, 2]);
    log.step("received ordered batch in order", { ordered });
  });
});

/* ================================================================== */
/* SQS dead-letter round-trip                                         */
/* ================================================================== */

describe.skipIf(!SQS_PRESENT)("AWS SQS dead-letter live lifecycle", () => {
  const log = liveLog("aws:sqs:dlq");
  let sourceUrl: string;
  let dlqUrl: string;
  let createdSource = false;
  let createdDlq = false;
  let rawClient: SQSClient | undefined;
  let backend: Awaited<ReturnType<typeof getQueue>> | undefined;

  beforeAll(async () => {
    rawClient = new SQSClient(awsClientConfig());
    const extras = getSqsExtrasConfig();

    // Resolve / create the DLQ first so we can read its ARN for the source's
    // RedrivePolicy.
    if (extras.dlqUrl !== undefined) {
      dlqUrl = extras.dlqUrl;
      log.step("using provided DLQ", { dlqUrl });
    } else {
      const dlqName = uniqueName("dlq");
      log.step("creating DLQ", { dlqName });
      const dlqRes = await rawClient.send(new CreateQueueCommand({ QueueName: dlqName }));
      dlqUrl = dlqRes.QueueUrl!;
      createdDlq = true;
      log.step("created DLQ", { dlqName, dlqUrl });
    }

    const arnRes = await rawClient.send(
      new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }),
    );
    const dlqArn = arnRes.Attributes?.QueueArn;
    expect(dlqArn).toBeTruthy();

    const sourceName = uniqueName("dlq-src");
    log.step("creating source queue with RedrivePolicy", { sourceName });
    const srcRes = await rawClient.send(
      new CreateQueueCommand({
        QueueName: sourceName,
        Attributes: {
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 5 }),
        },
      }),
    );
    sourceUrl = srcRes.QueueUrl!;
    createdSource = true;
    log.step("created source queue", { sourceName, sourceUrl });

    log.step("initializing backend", { provider: "sqs", queueUrl: sourceUrl });
    backend = await getQueue("sqs", { ...awsAuthOptions(), queueUrl: sourceUrl });
  });

  afterAll(async () => {
    try {
      await backend?.close();
      log.step("closed backend", { queueUrl: sourceUrl });
    } catch (err) {
      log.warn("backend close failed", err, { queueUrl: sourceUrl });
    }
    try {
      if (createdSource && rawClient) {
        await rawClient.send(new DeleteQueueCommand({ QueueUrl: sourceUrl }));
        log.step("deleted created source queue", { sourceUrl });
      }
    } catch (err) {
      log.warn("source cleanup failed", err, { sourceUrl });
    }
    try {
      if (createdDlq && rawClient) {
        await rawClient.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
        log.step("deleted created DLQ", { dlqUrl });
      }
    } catch (err) {
      log.warn("dlq cleanup failed", err, { dlqUrl });
    } finally {
      rawClient?.destroy();
    }
  });

  it("dead-letters a received message to the DLQ with the reason attribute", async () => {
    expect(backend).toBeDefined();
    const b = backend!;
    const marker = uniqueName("dlq-msg");
    const reason = "live-dead-letter-reason";

    log.step("sending message to source", { sourceUrl, marker });
    await b.send({ marker, n: 7 });

    const received = await b.receive(1, 20);
    expect(received.length).toBeGreaterThanOrEqual(1);
    const msg = received[0];
    expect(msg.body).toEqual({ marker, n: 7 });
    log.step("received from source", { marker });

    // Backend resolves the DLQ via the source RedrivePolicy and moves it there.
    await b.deadLetter(msg.receiptHandle, reason);
    log.step("dead-lettered message", { marker, reason });

    // Read it back from the DLQ directly (raw SDK) and assert body + reason.
    let dlqBody: Record<string, unknown> | undefined;
    let dlqReason: string | undefined;
    let dlqHandle: string | undefined;
    for (let attempt = 0; attempt < 6 && dlqBody === undefined; attempt += 1) {
      const res = await rawClient!.send(
        new ReceiveMessageCommand({
          QueueUrl: dlqUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 10,
          MessageAttributeNames: ["All"],
        }),
      );
      for (const m of res.Messages ?? []) {
        const body = JSON.parse(m.Body ?? "{}") as Record<string, unknown>;
        if (body.marker === marker) {
          dlqBody = body;
          dlqReason = m.MessageAttributes?.DeadLetterReason?.StringValue;
          dlqHandle = m.ReceiptHandle;
        }
      }
    }
    expect(dlqBody).toEqual({ marker, n: 7 });
    expect(dlqReason).toBe(reason);
    log.step("verified message in DLQ", { marker, reason });

    if (dlqHandle !== undefined) {
      await rawClient!.send(
        new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: dlqHandle }),
      );
    }
  });
});

/* ================================================================== */
/* SQS getQueueDepth                                                  */
/* ================================================================== */

describe.skipIf(!SQS_PRESENT)("AWS SQS getQueueDepth live lifecycle", () => {
  const log = liveLog("aws:sqs:depth");
  let queueUrl: string;
  let createdQueue = false;
  let rawClient: SQSClient | undefined;
  let backend: Awaited<ReturnType<typeof getQueue>> | undefined;

  beforeAll(async () => {
    // Always create a dedicated queue so depth assertions are not polluted by an
    // env-provided shared queue's backlog.
    rawClient = new SQSClient(awsClientConfig());
    const queueName = uniqueName("depth");
    log.step("creating queue", { queueName });
    const res = await rawClient.send(new CreateQueueCommand({ QueueName: queueName }));
    queueUrl = res.QueueUrl!;
    createdQueue = true;
    log.step("created queue", { queueName, queueUrl });
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
      if (createdQueue && rawClient) {
        await rawClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        log.step("deleted created queue", { queueUrl });
      }
    } catch (err) {
      log.warn("cleanup failed", err, { queueUrl });
    } finally {
      rawClient?.destroy();
    }
  });

  // retry:0 overrides the live lane's global retry:2. A retry would reuse this
  // describe's queue (created once in beforeAll), so messages sent by a failed
  // attempt would still be present and break the "starts empty" assertion. This
  // test instead absorbs eventual-consistency lag internally via pollQueueDepth.
  it("reports 0 on an empty queue then reflects N enqueued messages", { retry: 0 }, async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    // A brand-new queue starts empty, but ApproximateNumberOfMessages can lag;
    // poll rather than read once.
    const initial = await pollQueueDepth(b, 0);
    expect(initial).toBe(0);
    log.step("initial depth", { depth: initial });

    const n = 3;
    const marker = uniqueName("depth-msg");
    for (let i = 0; i < n; i += 1) {
      await b.send({ marker, i });
    }
    log.step("sent messages", { n });

    // ApproximateNumberOfMessages lags a burst of sends — a single read can
    // still observe 0. Poll until it converges to n.
    const depth = await pollQueueDepth(b, n);
    expect(depth).toBe(n);
    log.step("depth after sends", { depth });
  });
});

/* ================================================================== */
/* SQS nack (redelivery)                                              */
/* ================================================================== */

describe.skipIf(!SQS_PRESENT)("AWS SQS nack live lifecycle", () => {
  const log = liveLog("aws:sqs:nack");
  let queueUrl: string;
  let createdQueue = false;
  let rawClient: SQSClient | undefined;
  let backend: Awaited<ReturnType<typeof getQueue>> | undefined;

  beforeAll(async () => {
    rawClient = new SQSClient(awsClientConfig());
    const queueName = uniqueName("nack");
    log.step("creating queue", { queueName });
    const res = await rawClient.send(new CreateQueueCommand({ QueueName: queueName }));
    queueUrl = res.QueueUrl!;
    createdQueue = true;
    log.step("created queue", { queueName, queueUrl });
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
      if (createdQueue && rawClient) {
        await rawClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        log.step("deleted created queue", { queueUrl });
      }
    } catch (err) {
      log.warn("cleanup failed", err, { queueUrl });
    } finally {
      rawClient?.destroy();
    }
  });

  it("redelivers a nacked message with an incremented receiveCount", async () => {
    expect(backend).toBeDefined();
    const b = backend!;
    const marker = uniqueName("nack-msg");

    log.step("sending message", { queueUrl, marker });
    await b.send({ marker, n: 1 });

    const first = await b.receive(1, 20);
    expect(first.length).toBeGreaterThanOrEqual(1);
    const firstMsg = first[0];
    expect(firstMsg.body).toEqual({ marker, n: 1 });
    expect(firstMsg.receiveCount).toBe(1);
    log.step("first receive", { marker, receiveCount: firstMsg.receiveCount });

    // nack -> visibility timeout 0 -> immediately redeliverable.
    await b.nack(firstMsg.receiptHandle);
    log.step("nacked message", { marker });

    let redelivered: Message | undefined;
    for (let attempt = 0; attempt < 5 && redelivered === undefined; attempt += 1) {
      const batch = await b.receive(1, 20);
      for (const m of batch) {
        if (m.body.marker === marker) {
          redelivered = m;
        }
      }
    }
    expect(redelivered).toBeDefined();
    expect(redelivered!.body).toEqual({ marker, n: 1 });
    expect(redelivered!.receiveCount).toBeGreaterThanOrEqual(2);
    log.step("redelivered message", { marker, receiveCount: redelivered!.receiveCount });

    await b.delete(redelivered!.receiptHandle);
  });
});
