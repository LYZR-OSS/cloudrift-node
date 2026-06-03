import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPubsub, getQueue } from "../../src/index.js";
import type { MessagingBackend, PubSubBackend } from "../../src/index.js";
import {
  awsOptions,
  createQueue,
  createTopic,
  deleteQueue,
  deleteTopic,
  subscribeQueueToTopic,
  uniqueName,
} from "./harness.js";

/**
 * Black-box SNS behavior against LocalStack, driven through the public
 * `getPubsub("sns", ...)` factory. An SQS queue subscribed to the topic (raw
 * message delivery) is the delivery probe, and it is read back through the
 * public `getQueue("sqs", ...)` factory — so the whole publish->deliver->receive
 * path runs through cloudrift's public APIs.
 *
 * SNS delivery-probe / JSON decision:
 *   With RawMessageDelivery=true the SQS message body is the published string
 *   verbatim. The cloudrift SQS backend's `receive()` does `JSON.parse(body)`
 *   (see src/messaging/sqs.ts) and returns a `Message.body` object. To keep the
 *   assertions honest while reading through the public queue factory, we publish
 *   JSON strings and assert the parsed `body` deep-equals the original object.
 *   A non-JSON string would make the queue backend's `JSON.parse` throw, which
 *   would be testing SQS body handling, not SNS delivery.
 */
describe("SNS pub/sub (LocalStack)", () => {
  let topicArn: string;
  let queueUrl: string;
  let pubsub: PubSubBackend;
  let probe: MessagingBackend;

  beforeAll(async () => {
    topicArn = await createTopic(uniqueName("topic"));
    queueUrl = await createQueue(uniqueName("queue"));
    await subscribeQueueToTopic(topicArn, queueUrl);
    pubsub = await getPubsub("sns", awsOptions());
    probe = await getQueue("sqs", { ...awsOptions(), queueUrl });
  });

  afterAll(async () => {
    try {
      await pubsub.close();
    } catch {
      /* ignore */
    }
    try {
      await probe.close();
    } catch {
      /* ignore */
    }
    try {
      await deleteQueue(queueUrl);
    } catch {
      /* already gone */
    }
    try {
      await deleteTopic(topicArn);
    } catch {
      /* already gone */
    }
  });

  it("publishes and delivers the payload to the subscribed queue", async () => {
    const payload = { event: "user.created", id: 42, ok: true };

    const messageId = await pubsub.publish(topicArn, JSON.stringify(payload));
    expect(messageId).toBeTruthy();

    const received = await probe.receive(1, 10);
    expect(received).toHaveLength(1);
    expect(received[0].body).toEqual(payload);
  });

  it("publishBatch of 12 messages chunks at 10 and delivers all 12 distinct payloads", async () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({
      message: JSON.stringify({ seq: i }),
    }));

    const ids = await pubsub.publishBatch(topicArn, messages);
    expect(ids).toHaveLength(12);
    expect(ids.every((id) => id.length > 0)).toBe(true);

    // Drain the subscribed queue with bounded long-poll receives.
    const received: number[] = [];
    let iterations = 0;
    const maxIterations = 10;
    while (received.length < 12 && iterations < maxIterations) {
      iterations += 1;
      const batch = await probe.receive(10, 3);
      for (const m of batch) {
        received.push((m.body as { seq: number }).seq);
        await probe.delete(m.receiptHandle);
      }
    }
    expect(received.sort((a, b) => a - b)).toEqual([...Array(12).keys()]);
  });

  it("publishes with message attributes", async () => {
    // SNS raw delivery maps SNS message attributes onto SQS *message* attributes
    // (MessageAttributes), but the cloudrift SQS backend's receive() exposes only
    // the *system* attributes (m.Attributes) and does not request message
    // attributes. So the attribute round-trip is not observable through the
    // public delivery probe; we assert that an attributed publish succeeds and
    // that its payload still arrives.
    const payload = { kind: "with-attrs" };
    const messageId = await pubsub.publish(topicArn, JSON.stringify(payload), {
      source: "emulator-test",
      priority: "high",
    });
    expect(messageId).toBeTruthy();

    const received = await probe.receive(1, 10);
    expect(received).toHaveLength(1);
    expect(received[0].body).toEqual(payload);
  });

  it("reports healthy", async () => {
    expect(await pubsub.healthCheck()).toBe(true);
  });
});
