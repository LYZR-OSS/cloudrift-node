import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getQueue } from "../../src/index.js";
import type { MessagingBackend } from "../../src/index.js";
import { awsOptions, createQueue, deleteQueue, uniqueName } from "./harness.js";

/**
 * Black-box SQS behavior against LocalStack, driven entirely through the public
 * `getQueue("sqs", ...)` factory. Proves the JSON round-trip envelope, delayed
 * delivery, batch chunking (>10 entries), receipt-handle delete visibility, and
 * purge — the things SDK command-shape mocks cannot establish.
 *
 * Each test provisions its own fresh queue (cheap on LocalStack) so the suite
 * stays independent and deterministic: no shared mutable queue state, no cross-
 * test interference, and no sleeps — receives rely on the API's own bounded
 * long-poll wait.
 */
describe("SQS messaging (LocalStack)", () => {
  // A shared queue used by the simpler, non-destructive cases. Tests that mutate
  // queue-wide state (delay, drain, delete, purge) each create their own queue.
  let queueUrl: string;
  let queue: MessagingBackend;

  beforeAll(async () => {
    queueUrl = await createQueue(uniqueName("queue"));
    queue = await getQueue("sqs", { ...awsOptions(), queueUrl });
  });

  afterAll(async () => {
    try {
      await queue.close();
    } catch {
      /* ignore close failure so it cannot mask a test failure */
    }
    try {
      await deleteQueue(queueUrl);
    } catch {
      /* already gone */
    }
  });

  /** Provision a fresh queue + backend wired through the public factory. */
  async function freshQueue(): Promise<{ url: string; backend: MessagingBackend }> {
    const url = await createQueue(uniqueName("queue"));
    const backend = await getQueue("sqs", { ...awsOptions(), queueUrl: url });
    return { url, backend };
  }

  it("sends then receives a JSON round-trip Message envelope", async () => {
    const payload = { kind: "greeting", text: "hello cloudrift", count: 3, nested: { ok: true } };

    const messageId = await queue.send(payload);
    expect(messageId).toBeTruthy();

    const received = await queue.receive(1, 5);
    expect(received).toHaveLength(1);
    const [message] = received;
    expect(message.body).toEqual(payload);
    expect(message.id).toBeTruthy();
    expect(message.receiptHandle).toBeTruthy();
    expect(message.attributes).toBeTypeOf("object");
  });

  it("delays delivery so the message is invisible until the delay elapses", async () => {
    const { url, backend } = await freshQueue();
    try {
      const payload = { delayed: true };
      await backend.send(payload, 2);

      // Immediate, non-blocking receive must not see the delayed message.
      const immediate = await backend.receive(1, 0);
      expect(immediate).toHaveLength(0);

      // A single long-poll receive whose wait exceeds the delay must see it.
      // This uses the API's own bounded wait, not a sleep loop.
      const afterDelay = await backend.receive(1, 5);
      expect(afterDelay).toHaveLength(1);
      expect(afterDelay[0].body).toEqual(payload);
    } finally {
      try {
        await backend.close();
      } catch {
        /* ignore */
      }
      try {
        await deleteQueue(url);
      } catch {
        /* ignore */
      }
    }
  });

  it("sendBatch of 12 messages chunks at 10, returns 12 ids, and drains fully", async () => {
    const { url, backend } = await freshQueue();
    try {
      const messages = Array.from({ length: 12 }, (_, i) => ({ seq: i }));
      const ids = await backend.sendBatch(messages);
      expect(ids).toHaveLength(12);
      expect(ids.every((id) => id.length > 0)).toBe(true);

      // Drain via repeated long-poll receive + delete, bounded to a small number
      // of iterations. Fail the test if the queue is not drained in time.
      const drained: number[] = [];
      let iterations = 0;
      const maxIterations = 10;
      while (drained.length < 12 && iterations < maxIterations) {
        iterations += 1;
        const batch = await backend.receive(10, 2);
        for (const m of batch) {
          drained.push(m.body.seq as number);
          await backend.delete(m.receiptHandle);
        }
      }
      expect(drained.sort((a, b) => a - b)).toEqual([...Array(12).keys()]);
    } finally {
      try {
        await backend.close();
      } catch {
        /* ignore */
      }
      try {
        await deleteQueue(url);
      } catch {
        /* ignore */
      }
    }
  });

  it("delete by receipt handle prevents the message from reappearing", async () => {
    const { url, backend } = await freshQueue();
    try {
      await backend.send({ once: true });

      const received = await backend.receive(1, 5);
      expect(received).toHaveLength(1);
      await backend.delete(received[0].receiptHandle);

      // A subsequent short-wait receive must not return the deleted message.
      const after = await backend.receive(1, 1);
      expect(after).toHaveLength(0);
    } finally {
      try {
        await backend.close();
      } catch {
        /* ignore */
      }
      try {
        await deleteQueue(url);
      } catch {
        /* ignore */
      }
    }
  });

  it("purge empties the queue", async () => {
    // Dedicated fresh queue: real SQS throttles PurgeQueue to once per 60s.
    const { url, backend } = await freshQueue();
    try {
      await backend.send({ a: 1 });
      await backend.send({ b: 2 });
      await backend.send({ c: 3 });

      await backend.purge();

      const after = await backend.receive(10, 1);
      expect(after).toEqual([]);
    } finally {
      try {
        await backend.close();
      } catch {
        /* ignore */
      }
      try {
        await deleteQueue(url);
      } catch {
        /* ignore */
      }
    }
  });

  it("reports healthy", async () => {
    expect(await queue.healthCheck()).toBe(true);
  });
});
