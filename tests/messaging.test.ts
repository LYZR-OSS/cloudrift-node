import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SQSClient,
  SendMessageCommand,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";

import { getQueue } from "../src/messaging/index.js";
import { AWSSQSBackend } from "../src/messaging/sqs.js";
import { AzureServiceBusBackend } from "../src/messaging/azureBus.js";
import {
  FeatureNotSupportedError,
  MessageSendError,
  MessagingError,
  QueueNotFoundError,
} from "../src/core/errors.js";
import { MessagingBackend as MessagingBackendBase } from "../src/messaging/base.js";
import type { MessagingBackend, Message } from "../src/messaging/base.js";

const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue";

const sqsMock = mockClient(SQSClient);
const credentialProviderMock = vi.hoisted(() => ({
  fromIni: vi.fn(() => async () => ({
    accessKeyId: "profile-key",
    secretAccessKey: "profile-secret",
  })),
}));

vi.mock("@aws-sdk/credential-providers", () => credentialProviderMock);

function makeBackend(): MessagingBackend {
  return AWSSQSBackend.fromAccessKey({
    queueUrl: QUEUE_URL,
    awsAccessKeyId: "test",
    awsSecretAccessKey: "test",
    region: "us-east-1",
  });
}

/* ------------------------------------------------------------------ */
/* MessagingBackend abstract base default methods                       */
/* ------------------------------------------------------------------ */

class MinimalMessagingBackend extends MessagingBackendBase {
  send(): Promise<string> {
    return Promise.resolve("id");
  }
  sendBatch(): Promise<string[]> {
    return Promise.resolve([]);
  }
  receive(): Promise<Message[]> {
    return Promise.resolve([]);
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  deadLetter(): Promise<void> {
    return Promise.resolve();
  }
  getQueueDepth(): Promise<number> {
    return Promise.resolve(0);
  }
  purge(): Promise<void> {
    return Promise.resolve();
  }
}

describe("MessagingBackend base defaults", () => {
  it("healthCheck defaults to true", async () => {
    const b = new MinimalMessagingBackend();
    expect(await b.healthCheck()).toBe(true);
  });

  it("close defaults to a resolved no-op", async () => {
    const b = new MinimalMessagingBackend();
    await expect(b.close()).resolves.toBeUndefined();
  });

  it("Symbol.asyncDispose delegates to close", async () => {
    const b = new MinimalMessagingBackend();
    const spy = vi.spyOn(b, "close");
    await b[Symbol.asyncDispose]();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("nack defaults to rejecting with FeatureNotSupportedError naming the backend", async () => {
    const b = new MinimalMessagingBackend();
    await expect(b.nack("rh")).rejects.toBeInstanceOf(FeatureNotSupportedError);
    await expect(b.nack("rh")).rejects.toThrow("MinimalMessagingBackend does not support nack()");
  });
});

describe("AWSSQSBackend", () => {
  let backend: MessagingBackend;

  beforeEach(() => {
    sqsMock.reset();
    credentialProviderMock.fromIni.mockReset();
    credentialProviderMock.fromIni.mockReturnValue(async () => ({
      accessKeyId: "profile-key",
      secretAccessKey: "profile-secret",
    }));
    backend = makeBackend();
  });

  afterEach(async () => {
    await backend.close();
  });

  it("send returns the message id and JSON-serializes the body", async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "msg-1" });

    const id = await backend.send({ action: "greet", name: "cloudrift" });

    expect(id).toBe("msg-1");
    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({ action: "greet", name: "cloudrift" }),
    });
    // Matches Python e643def: a zero delay omits DelaySeconds entirely
    // (only FIFO/standard params are added when non-empty).
    expect(calls[0].args[0].input.DelaySeconds).toBeUndefined();
  });

  it("send passes DelaySeconds through", async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "msg-d" });

    await backend.send({ x: 1 }, 42);

    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls[0].args[0].input.DelaySeconds).toBe(42);
  });

  it("sendBatch returns successful message ids", async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({
      Successful: [
        { Id: "0", MessageId: "a", MD5OfMessageBody: "x" },
        { Id: "1", MessageId: "b", MD5OfMessageBody: "y" },
        { Id: "2", MessageId: "c", MD5OfMessageBody: "z" },
      ],
    });

    const ids = await backend.sendBatch([{ n: 1 }, { n: 2 }, { n: 3 }]);

    expect(ids).toEqual(["a", "b", "c"]);
    const calls = sqsMock.commandCalls(SendMessageBatchCommand);
    expect(calls[0].args[0].input.Entries).toEqual([
      { Id: "0", MessageBody: JSON.stringify({ n: 1 }) },
      { Id: "1", MessageBody: JSON.stringify({ n: 2 }) },
      { Id: "2", MessageBody: JSON.stringify({ n: 3 }) },
    ]);
  });

  it("sendBatch chunks inputs over the AWS limit of 10 entries", async () => {
    sqsMock.on(SendMessageBatchCommand).callsFake((input) => {
      const entries = input.Entries as Array<{ Id: string }>;
      return {
        Successful: entries.map((entry) => ({
          Id: entry.Id,
          MessageId: `msg-${entry.Id}`,
          MD5OfMessageBody: "md5",
        })),
      };
    });

    const messages = Array.from({ length: 25 }, (_, n) => ({ n }));
    const ids = await backend.sendBatch(messages);

    expect(ids).toEqual(messages.map((_, n) => `msg-${n}`));
    const calls = sqsMock.commandCalls(SendMessageBatchCommand);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.args[0].input.Entries?.length)).toEqual([10, 10, 5]);
    expect(calls[1].args[0].input.Entries?.[0]).toMatchObject({
      Id: "10",
      MessageBody: JSON.stringify({ n: 10 }),
    });
  });

  it("sendBatch throws MessageSendError when an entry fails", async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({
      Successful: [{ Id: "0", MessageId: "a", MD5OfMessageBody: "x" }],
      Failed: [{ Id: "1", SenderFault: true, Code: "InternalError", Message: "boom" }],
    });

    await expect(backend.sendBatch([{ n: 1 }, { n: 2 }])).rejects.toBeInstanceOf(MessageSendError);
  });

  it("receive parses JSON bodies and returns the Message shape", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [
        {
          MessageId: "msg-1",
          Body: JSON.stringify({ action: "greet", name: "cloudrift" }),
          ReceiptHandle: "rh-1",
          Attributes: { SenderId: "AIDA", SentTimestamp: "123" },
        },
      ],
    });

    const messages = await backend.receive(1, 0);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      id: "msg-1",
      body: { action: "greet", name: "cloudrift" },
      receiptHandle: "rh-1",
      attributes: { SenderId: "AIDA", SentTimestamp: "123" },
    });
    const calls = sqsMock.commandCalls(ReceiveMessageCommand);
    expect(calls[0].args[0].input).toMatchObject({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 0,
      AttributeNames: ["All"],
    });
  });

  it("receive returns [] and caps MaxNumberOfMessages at 10", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({});

    const messages = await backend.receive(50);

    expect(messages).toEqual([]);
    const calls = sqsMock.commandCalls(ReceiveMessageCommand);
    expect(calls[0].args[0].input.MaxNumberOfMessages).toBe(10);
  });

  it("delete issues a DeleteMessageCommand with the receipt handle", async () => {
    sqsMock.on(DeleteMessageCommand).resolves({});

    await backend.delete("rh-1");

    const calls = sqsMock.commandCalls(DeleteMessageCommand);
    expect(calls[0].args[0].input).toMatchObject({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: "rh-1",
    });
  });

  it("purge issues a PurgeQueueCommand", async () => {
    sqsMock.on(PurgeQueueCommand).resolves({});

    await backend.purge();

    const calls = sqsMock.commandCalls(PurgeQueueCommand);
    expect(calls[0].args[0].input).toMatchObject({ QueueUrl: QUEUE_URL });
  });

  it("healthCheck calls GetQueueAttributes with QueueArn", async () => {
    sqsMock.on(GetQueueAttributesCommand).resolves({ Attributes: { QueueArn: "arn:aws:sqs:..." } });

    const ok = await backend.healthCheck();

    expect(ok).toBe(true);
    const calls = sqsMock.commandCalls(GetQueueAttributesCommand);
    expect(calls[0].args[0].input).toMatchObject({
      QueueUrl: QUEUE_URL,
      AttributeNames: ["QueueArn"],
    });
  });

  it("healthCheck returns false on error", async () => {
    sqsMock.on(GetQueueAttributesCommand).rejects(new Error("nope"));

    expect(await backend.healthCheck()).toBe(false);
  });

  it("retries lazy client creation after a failed profile init", async () => {
    await backend.close();
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "msg-retry" });
    credentialProviderMock.fromIni
      .mockImplementationOnce(() => {
        throw new Error("profile unavailable");
      })
      .mockReturnValueOnce(async () => ({
        accessKeyId: "retry-key",
        secretAccessKey: "retry-secret",
      }));
    backend = AWSSQSBackend.fromProfile({
      queueUrl: QUEUE_URL,
      profileName: "dev",
      region: "us-east-1",
    });

    await expect(backend.send({ attempt: 1 })).rejects.toThrow(/profile unavailable/);
    await expect(backend.send({ attempt: 2 })).resolves.toBe("msg-retry");

    expect(credentialProviderMock.fromIni).toHaveBeenCalledTimes(2);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("send returns empty string when the SDK omits MessageId (sqs.ts:205)", async () => {
    sqsMock.on(SendMessageCommand).resolves({});

    const id = await backend.send({ a: 1 });

    expect(id).toBe("");
  });

  it("receive maps missing fields to exact defaults (sqs.ts:253-256)", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [{}],
    });

    const messages = await backend.receive(1, 0);

    expect(messages).toEqual([
      {
        id: "",
        body: {},
        receiptHandle: "",
        attributes: {},
      },
    ]);
  });

  it("receive passes WaitTimeSeconds and small MaxNumberOfMessages through (sqs.ts:247-249)", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({});

    await backend.receive(3, 7);

    const calls = sqsMock.commandCalls(ReceiveMessageCommand);
    expect(calls[0].args[0].input).toEqual({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: 3,
      WaitTimeSeconds: 7,
      AttributeNames: ["All"],
    });
  });

  it("sendBatch reports the failed entry ids in the error message (sqs.ts:228-230)", async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({
      Successful: [{ Id: "0", MessageId: "a", MD5OfMessageBody: "x" }],
      Failed: [
        { Id: "1", SenderFault: true, Code: "InternalError", Message: "boom" },
        { Id: "2", SenderFault: true, Code: "InternalError", Message: "boom" },
      ],
    });

    await expect(backend.sendBatch([{ n: 1 }, { n: 2 }, { n: 3 }])).rejects.toThrow(
      `Failed to send messages with IDs: ${JSON.stringify(["1", "2"])}`,
    );
  });

  it("sendBatch maps missing Successful MessageId to empty string (sqs.ts:232)", async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({
      Successful: [{ Id: "0", MD5OfMessageBody: "x" }] as unknown as never,
    });

    const ids = await backend.sendBatch([{ n: 1 }]);

    expect(ids).toEqual([""]);
  });

  it("sendBatch with no messages issues no command and returns [] (sqs.ts:216)", async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({ Successful: [] });

    const ids = await backend.sendBatch([]);

    expect(ids).toEqual([]);
    expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
  });

  it("maps NonExistentQueue errors to QueueNotFoundError with the queue url (sqs.ts:318-319)", async () => {
    const awsErr = Object.assign(new Error("queue gone"), {
      name: "AWS.SimpleQueueService.NonExistentQueue",
    });
    sqsMock.on(SendMessageCommand).rejects(awsErr);

    await expect(backend.send({ a: 1 })).rejects.toMatchObject({
      name: "QueueNotFoundError",
      message: `Queue not found: ${QUEUE_URL}`,
    });
  });

  it("maps QueueDoesNotExist errors to QueueNotFoundError (sqs.ts:318)", async () => {
    const awsErr = Object.assign(new Error("nope"), { name: "QueueDoesNotExist" });
    sqsMock.on(DeleteMessageCommand).rejects(awsErr);

    await expect(backend.delete("rh")).rejects.toMatchObject({
      name: "QueueNotFoundError",
      message: `Queue not found: ${QUEUE_URL}`,
    });
  });

  it("maps InvalidMessageContents to MessageSendError with the error message (sqs.ts:324-327)", async () => {
    const awsErr = Object.assign(new Error("bad contents"), { name: "InvalidMessageContents" });
    sqsMock.on(SendMessageCommand).rejects(awsErr);

    const err = await backend.send({ a: 1 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MessageSendError);
    expect((err as Error).message).toBe("bad contents");
    expect((err as Error).cause).toBe(awsErr);
  });

  it("maps the batch-entry-id error code to MessageSendError (sqs.ts:324)", async () => {
    const awsErr = Object.assign(new Error("dup id"), {
      name: "SendMessageBatchRequestEntry.SendMessageBatchRequestEntryId",
    });
    sqsMock.on(SendMessageBatchCommand).rejects(awsErr);

    await expect(backend.sendBatch([{ n: 1 }])).rejects.toBeInstanceOf(MessageSendError);
  });

  it("maps unknown SDK errors to a generic MessagingError preserving cause (sqs.ts:329)", async () => {
    const awsErr = Object.assign(new Error("throttled"), { name: "ThrottlingException" });
    sqsMock.on(SendMessageCommand).rejects(awsErr);

    const err = await backend.send({ a: 1 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MessagingError);
    expect(err).not.toBeInstanceOf(QueueNotFoundError);
    expect(err).not.toBeInstanceOf(MessageSendError);
    expect((err as Error).message).toBe("throttled");
    expect((err as Error).cause).toBe(awsErr);
  });

  it("derives the error code from the Code property when name is not a string (sqs.ts:341-342)", async () => {
    // name is a non-string -> errorCode falls through to the Code field.
    // callsFake throws our object verbatim (no SDK error normalization).
    const awsErr = { name: 123, Code: "QueueDoesNotExist" };
    sqsMock.on(SendMessageCommand).callsFake(() => {
      throw awsErr;
    });

    await expect(backend.send({ a: 1 })).rejects.toBeInstanceOf(QueueNotFoundError);
  });

  it("falls back to a generic MessagingError when neither name nor Code is a string (sqs.ts:342)", async () => {
    const awsErr = { name: 123, Code: 456 };
    sqsMock.on(SendMessageCommand).callsFake(() => {
      throw awsErr;
    });

    const err = await backend.send({ a: 1 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MessagingError);
    expect(err).not.toBeInstanceOf(QueueNotFoundError);
    expect(err).not.toBeInstanceOf(MessageSendError);
  });
});

/* ------------------------------------------------------------------ */
/* AWSSQSBackend FIFO + dead-letter + depth (Python e643def/8de15b0)    */
/* ------------------------------------------------------------------ */

const FIFO_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue.fifo";

function makeFifoBackend(): AWSSQSBackend {
  return AWSSQSBackend.fromAccessKey({
    queueUrl: FIFO_QUEUE_URL,
    awsAccessKeyId: "test",
    awsSecretAccessKey: "test",
    region: "us-east-1",
  });
}

describe("AWSSQSBackend FIFO + dead-letter + depth", () => {
  let backend: AWSSQSBackend;

  beforeEach(() => {
    sqsMock.reset();
    backend = makeBackend() as AWSSQSBackend;
  });

  afterEach(async () => {
    await backend.close();
  });

  it("send rejects groupId/dedupId on a standard (non-FIFO) queue", async () => {
    await expect(backend.send({ a: 1 }, 0, { groupId: "g" })).rejects.toBeInstanceOf(
      FeatureNotSupportedError,
    );
  });

  it("FIFO send requires groupId and forwards MessageGroupId/DeduplicationId", async () => {
    const fifo = makeFifoBackend();
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "f-1" });

    await expect(fifo.send({ a: 1 })).rejects.toBeInstanceOf(MessageSendError);

    const id = await fifo.send({ a: 1 }, 0, { groupId: "grp", dedupId: "dd" });
    expect(id).toBe("f-1");
    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls[0].args[0].input).toMatchObject({
      MessageGroupId: "grp",
      MessageDeduplicationId: "dd",
    });
    expect(calls[0].args[0].input.DelaySeconds).toBeUndefined();
    await fifo.close();
  });

  it("FIFO send rejects a per-message delay", async () => {
    const fifo = makeFifoBackend();
    await expect(fifo.send({ a: 1 }, 5, { groupId: "g" })).rejects.toBeInstanceOf(
      FeatureNotSupportedError,
    );
    await fifo.close();
  });

  it("standard send omits DelaySeconds when delay is 0 and includes it otherwise", async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "x" });
    await backend.send({ a: 1 }, 0);
    await backend.send({ a: 1 }, 7);
    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls[0].args[0].input.DelaySeconds).toBeUndefined();
    expect(calls[1].args[0].input.DelaySeconds).toBe(7);
  });

  it("FIFO sendBatch threads groupId and parallel dedupIds onto each entry", async () => {
    const fifo = makeFifoBackend();
    sqsMock.on(SendMessageBatchCommand).resolves({
      Successful: [
        { Id: "0", MessageId: "a", MD5OfMessageBody: "x" },
        { Id: "1", MessageId: "b", MD5OfMessageBody: "y" },
      ],
    });

    const ids = await fifo.sendBatch([{ n: 1 }, { n: 2 }], {
      groupId: "grp",
      dedupIds: ["d0", "d1"],
    });
    expect(ids).toEqual(["a", "b"]);
    const entries = sqsMock.commandCalls(SendMessageBatchCommand)[0].args[0].input.Entries!;
    expect(entries[0]).toMatchObject({ MessageGroupId: "grp", MessageDeduplicationId: "d0" });
    expect(entries[1]).toMatchObject({ MessageGroupId: "grp", MessageDeduplicationId: "d1" });
    await fifo.close();
  });

  it("sendBatch rejects when dedupIds length does not match messages", async () => {
    const fifo = makeFifoBackend();
    await expect(
      fifo.sendBatch([{ n: 1 }, { n: 2 }], { groupId: "g", dedupIds: ["only-one"] }),
    ).rejects.toThrow("dedupIds must be parallel to messages");
    await fifo.close();
  });

  it("receive surfaces groupId/dedupId/receiveCount from message attributes", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [
        {
          MessageId: "m1",
          Body: JSON.stringify({ n: 1 }),
          ReceiptHandle: "rh-1",
          Attributes: {
            MessageGroupId: "grp",
            MessageDeduplicationId: "dd",
            ApproximateReceiveCount: "3",
          },
        },
      ],
    });

    const [msg] = await backend.receive(1, 0);
    expect(msg.groupId).toBe("grp");
    expect(msg.dedupId).toBe("dd");
    expect(msg.receiveCount).toBe(3);
  });

  it("receive leaves FIFO fields undefined when attributes are absent", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [{ MessageId: "m", Body: "{}", ReceiptHandle: "rh", Attributes: {} }],
    });
    const [msg] = await backend.receive(1, 0);
    expect(msg.groupId).toBeUndefined();
    expect(msg.dedupId).toBeUndefined();
    expect(msg.receiveCount).toBeUndefined();
  });

  it("receive forwards VisibilityTimeout only when provided", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({});
    await backend.receive(1, 0);
    await backend.receive(1, 0, { visibilityTimeout: 45 });
    const calls = sqsMock.commandCalls(ReceiveMessageCommand);
    expect(calls[0].args[0].input.VisibilityTimeout).toBeUndefined();
    expect(calls[1].args[0].input.VisibilityTimeout).toBe(45);
  });

  it("receive rejects a groupId filter (SQS cannot select a group)", async () => {
    await expect(backend.receive(1, 0, { groupId: "g" })).rejects.toBeInstanceOf(
      FeatureNotSupportedError,
    );
  });

  it("nack sets VisibilityTimeout to 0 and clears pending", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [{ MessageId: "m", Body: JSON.stringify({ n: 1 }), ReceiptHandle: "rh-n" }],
    });
    sqsMock.on(ChangeMessageVisibilityCommand).resolves({});
    await backend.receive(1, 0);

    await backend.nack("rh-n");

    const calls = sqsMock.commandCalls(ChangeMessageVisibilityCommand);
    expect(calls[0].args[0].input).toMatchObject({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: "rh-n",
      VisibilityTimeout: 0,
    });
    // deadLetter after nack -> no pending body retained
    await expect(backend.deadLetter("rh-n", "late")).rejects.toThrow(/No pending message/);
  });

  it("deadLetter re-sends the retained body to an explicit DLQ then deletes the original", async () => {
    const dlqUrl = "https://sqs.us-east-1.amazonaws.com/123456789012/dlq";
    const b = AWSSQSBackend.fromAccessKey({
      queueUrl: QUEUE_URL,
      awsAccessKeyId: "t",
      awsSecretAccessKey: "t",
      region: "us-east-1",
      dlqUrl,
    });
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [{ MessageId: "m", Body: JSON.stringify({ payload: 9 }), ReceiptHandle: "rh-dl" }],
    });
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "dlq-1" });
    sqsMock.on(DeleteMessageCommand).resolves({});

    await b.receive(1, 0);
    await b.deadLetter("rh-dl", "poison");

    const send = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input;
    expect(send.QueueUrl).toBe(dlqUrl);
    expect(send.MessageBody).toBe(JSON.stringify({ payload: 9 }));
    expect(send.MessageAttributes).toMatchObject({
      DeadLetterReason: { DataType: "String", StringValue: "poison" },
    });
    expect(sqsMock.commandCalls(DeleteMessageCommand)[0].args[0].input).toMatchObject({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: "rh-dl",
    });
    // pending cleared on success
    await expect(b.deadLetter("rh-dl", "again")).rejects.toThrow(/No pending message/);
    await b.close();
  });

  it("deadLetter clears pending even when the DLQ send fails (any outcome)", async () => {
    const b = AWSSQSBackend.fromAccessKey({
      queueUrl: QUEUE_URL,
      awsAccessKeyId: "t",
      awsSecretAccessKey: "t",
      region: "us-east-1",
      dlqUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/dlq",
    });
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [{ MessageId: "m", Body: "{}", ReceiptHandle: "rh-fail" }],
    });
    sqsMock.on(SendMessageCommand).rejects(new Error("dlq down"));
    await b.receive(1, 0);

    await expect(b.deadLetter("rh-fail", "x")).rejects.toBeInstanceOf(MessagingError);
    // pending was cleared in finally -> a retry now reports no pending message
    await expect(b.deadLetter("rh-fail", "x")).rejects.toThrow(/No pending message/);
    await b.close();
  });

  it("deadLetter without a retained body throws MessagingError", async () => {
    await expect(backend.deadLetter("never-received", "x")).rejects.toThrow(/No pending message/);
  });

  it("deadLetter PRESERVES the pending body when DLQ resolution fails (sqs.ts deadLetter)", async () => {
    // No explicit dlqUrl -> deadLetter must resolve from RedrivePolicy. If that
    // GetQueueAttributes call fails, the body must survive for a retry. Python
    // (sqs.py:298-311) resolves the DLQ url OUTSIDE the try/finally.
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [
        { MessageId: "m", Body: JSON.stringify({ payload: 7 }), ReceiptHandle: "rh-keep" },
      ],
    });
    // First resolution attempt fails; second succeeds via RedrivePolicy.
    const dlqUrl = "https://sqs.us-east-1.amazonaws.com/123456789012/recovered-dlq";
    sqsMock
      .on(GetQueueAttributesCommand)
      .rejectsOnce(new Error("attributes unavailable"))
      .resolves({
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: "arn:aws:sqs:us-east-1:123456789012:recovered-dlq",
            maxReceiveCount: 5,
          }),
        },
      });
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: dlqUrl });
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "x" });
    sqsMock.on(DeleteMessageCommand).resolves({});

    await backend.receive(1, 0);

    // First attempt: resolution fails -> error surfaces, body NOT cleared.
    await expect(backend.deadLetter("rh-keep", "boom")).rejects.toThrow(/attributes unavailable/);

    // Retry: resolution now succeeds and the retained body is sent to the DLQ.
    await backend.deadLetter("rh-keep", "boom");
    const send = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input;
    expect(send.QueueUrl).toBe(dlqUrl);
    expect(send.MessageBody).toBe(JSON.stringify({ payload: 7 }));
    // body cleared only after the successful send+delete.
    await expect(backend.deadLetter("rh-keep", "again")).rejects.toThrow(/No pending message/);
  });

  it("deadLetter resolves the DLQ url from the source queue RedrivePolicy when not configured", async () => {
    const dlqUrl = "https://sqs.us-east-1.amazonaws.com/123456789012/derived-dlq";
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [{ MessageId: "m", Body: "{}", ReceiptHandle: "rh-r" }],
    });
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: "arn:aws:sqs:us-east-1:123456789012:derived-dlq",
          maxReceiveCount: 5,
        }),
      },
    });
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: dlqUrl });
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "x" });
    sqsMock.on(DeleteMessageCommand).resolves({});

    await backend.receive(1, 0);
    await backend.deadLetter("rh-r", "boom");

    expect(sqsMock.commandCalls(GetQueueUrlCommand)[0].args[0].input).toMatchObject({
      QueueName: "derived-dlq",
    });
    expect(sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.QueueUrl).toBe(dlqUrl);
  });

  it("deadLetter throws when no DLQ is configured and no RedrivePolicy exists", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [{ MessageId: "m", Body: "{}", ReceiptHandle: "rh-no" }],
    });
    sqsMock.on(GetQueueAttributesCommand).resolves({ Attributes: {} });
    await backend.receive(1, 0);
    await expect(backend.deadLetter("rh-no", "x")).rejects.toThrow(
      /No dead-letter queue configured/,
    );
  });

  it("getQueueDepth parses ApproximateNumberOfMessages", async () => {
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: "42" },
    });
    expect(await backend.getQueueDepth()).toBe(42);
    expect(sqsMock.commandCalls(GetQueueAttributesCommand)[0].args[0].input).toMatchObject({
      QueueUrl: QUEUE_URL,
      AttributeNames: ["ApproximateNumberOfMessages"],
    });
  });

  it("getQueueDepth throws MessagingError when ApproximateNumberOfMessages is absent", async () => {
    // Python (sqs.py:320) indexes the attribute directly -> KeyError when
    // missing. Node must raise a domain error rather than returning NaN.
    sqsMock.on(GetQueueAttributesCommand).resolves({ Attributes: {} });
    await expect(backend.getQueueDepth()).rejects.toBeInstanceOf(MessagingError);
    await expect(backend.getQueueDepth()).rejects.toThrow(/ApproximateNumberOfMessages/);
  });

  it("getQueueDepth throws when Attributes is entirely absent", async () => {
    sqsMock.on(GetQueueAttributesCommand).resolves({});
    await expect(backend.getQueueDepth()).rejects.toBeInstanceOf(MessagingError);
  });

  it("delete clears the retained pending body", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [{ MessageId: "m", Body: "{}", ReceiptHandle: "rh-del" }],
    });
    sqsMock.on(DeleteMessageCommand).resolves({});
    await backend.receive(1, 0);
    await backend.delete("rh-del");
    await expect(backend.deadLetter("rh-del", "x")).rejects.toThrow(/No pending message/);
  });

  it("purge clears retained pending bodies", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [{ MessageId: "m", Body: "{}", ReceiptHandle: "rh-p" }],
    });
    sqsMock.on(PurgeQueueCommand).resolves({});
    await backend.receive(1, 0);
    await backend.purge();
    await expect(backend.deadLetter("rh-p", "x")).rejects.toThrow(/No pending message/);
  });
});

/* ------------------------------------------------------------------ */
/* Azure Service Bus — driven through a mocked @azure/service-bus SDK   */
/* ------------------------------------------------------------------ */

// A controllable fake receiver. Each receiveMessages() call drains one batch
// from a queued script of message batches.
class FakeReceiver {
  closed = false;
  completed: unknown[] = [];
  abandoned: unknown[] = [];
  deadLettered: Array<{ message: unknown; options: unknown }> = [];
  // Records [maxMessages, options] for each receiveMessages() call.
  receiveCalls: Array<{ maxMessages: unknown; options: unknown }> = [];
  // When set, receiveMessages rejects with this error before draining.
  failReceive: unknown;
  // When set, completeMessage rejects with this error.
  failComplete: unknown;
  private batches: Array<Array<Record<string, unknown>>>;

  constructor(batches: Array<Array<Record<string, unknown>>>) {
    this.batches = batches;
  }

  async receiveMessages(
    maxMessages?: unknown,
    options?: unknown,
  ): Promise<Array<Record<string, unknown>>> {
    this.receiveCalls.push({ maxMessages, options });
    if (this.failReceive !== undefined) {
      throw this.failReceive;
    }
    return this.batches.shift() ?? [];
  }

  async completeMessage(msg: unknown): Promise<void> {
    if (this.failComplete !== undefined) {
      throw this.failComplete;
    }
    this.completed.push(msg);
  }

  async abandonMessage(msg: unknown): Promise<void> {
    this.abandoned.push(msg);
  }

  async deadLetterMessage(msg: unknown, options?: unknown): Promise<void> {
    this.deadLettered.push({ message: msg, options });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeSender {
  closed = false;
  sent: unknown[] = [];
  scheduled: unknown[] = [];
  // Records [message, scheduledTime] for each scheduleMessages() call.
  scheduledArgs: Array<{ message: unknown; scheduledTime: unknown }> = [];
  // When set, sendMessages rejects with this error.
  failSend: unknown;

  async sendMessages(m: unknown): Promise<void> {
    if (this.failSend !== undefined) {
      throw this.failSend;
    }
    this.sent.push(m);
  }

  async scheduleMessages(m: unknown, scheduledTime?: unknown): Promise<void> {
    this.scheduled.push(m);
    this.scheduledArgs.push({ message: m, scheduledTime });
  }

  async createMessageBatch(): Promise<{
    messages: unknown[];
    tryAddMessage(m: unknown): boolean;
  }> {
    const messages: unknown[] = [];
    return {
      messages,
      tryAddMessage(m: unknown) {
        if (
          sbHarness.batchMaxMessages !== undefined &&
          messages.length >= sbHarness.batchMaxMessages
        ) {
          return false;
        }
        messages.push(m);
        return true;
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

// Module-level harness the mocked SDK reads from.
const sbHarness: {
  receivers: FakeReceiver[];
  senders: FakeSender[];
  receiveScript: Array<Array<Record<string, unknown>>>;
  lastClientArgs: unknown[];
  clientClosed: boolean;
  failNextClientCreations: number;
  batchMaxMessages?: number;
  // When set, the next created sender/receiver is armed to fail with this error.
  nextSenderFailSend?: unknown;
  nextReceiverFailReceive?: unknown;
  // Records acceptSession/acceptNextSession calls.
  acceptSessionCalls: Array<{ queueName: unknown; sessionId: unknown; options: unknown }>;
  // When set, the next acceptSession/acceptNextSession rejects with this error.
  nextAcceptSessionError?: unknown;
  // Number of sessions acceptNextSession yields before it starts timing out.
  sessionsAvailable: number;
  // Last ServiceBusAdministrationClient instance + queue depth it reports.
  adminArgs: unknown[];
  queueDepth: number;
  adminError?: unknown;
} = {
  receivers: [],
  senders: [],
  receiveScript: [],
  lastClientArgs: [],
  clientClosed: false,
  failNextClientCreations: 0,
  batchMaxMessages: undefined,
  nextSenderFailSend: undefined,
  nextReceiverFailReceive: undefined,
  acceptSessionCalls: [],
  nextAcceptSessionError: undefined,
  sessionsAvailable: 0,
  adminArgs: [],
  queueDepth: 0,
  adminError: undefined,
};

vi.mock("@azure/service-bus", () => {
  class ServiceBusClient {
    constructor(...args: unknown[]) {
      if (sbHarness.failNextClientCreations > 0) {
        sbHarness.failNextClientCreations -= 1;
        throw new Error("service bus init unavailable");
      }
      sbHarness.lastClientArgs = args;
    }
    createReceiver(): FakeReceiver {
      const r = new FakeReceiver([sbHarness.receiveScript.shift() ?? []]);
      if (sbHarness.nextReceiverFailReceive !== undefined) {
        r.failReceive = sbHarness.nextReceiverFailReceive;
        sbHarness.nextReceiverFailReceive = undefined;
      }
      sbHarness.receivers.push(r);
      return r;
    }
    createSender(): FakeSender {
      const s = new FakeSender();
      if (sbHarness.nextSenderFailSend !== undefined) {
        s.failSend = sbHarness.nextSenderFailSend;
        sbHarness.nextSenderFailSend = undefined;
      }
      sbHarness.senders.push(s);
      return s;
    }
    async acceptSession(
      queueName: unknown,
      sessionId: unknown,
      options?: unknown,
    ): Promise<FakeReceiver> {
      sbHarness.acceptSessionCalls.push({ queueName, sessionId, options });
      if (sbHarness.nextAcceptSessionError !== undefined) {
        const err = sbHarness.nextAcceptSessionError;
        sbHarness.nextAcceptSessionError = undefined;
        throw err;
      }
      const r = new FakeReceiver([sbHarness.receiveScript.shift() ?? []]);
      sbHarness.receivers.push(r);
      return r;
    }
    async acceptNextSession(queueName: unknown, options?: unknown): Promise<FakeReceiver> {
      sbHarness.acceptSessionCalls.push({ queueName, sessionId: undefined, options });
      if (sbHarness.nextAcceptSessionError !== undefined) {
        const err = sbHarness.nextAcceptSessionError;
        sbHarness.nextAcceptSessionError = undefined;
        throw err;
      }
      if (sbHarness.sessionsAvailable <= 0) {
        throw Object.assign(new Error("no session"), { code: "ServiceTimeout" });
      }
      sbHarness.sessionsAvailable -= 1;
      const r = new FakeReceiver([sbHarness.receiveScript.shift() ?? []]);
      sbHarness.receivers.push(r);
      return r;
    }
    async close(): Promise<void> {
      sbHarness.clientClosed = true;
    }
  }
  class ServiceBusAdministrationClient {
    constructor(...args: unknown[]) {
      sbHarness.adminArgs = args;
    }
    async getQueueRuntimeProperties(): Promise<{ activeMessageCount: number }> {
      if (sbHarness.adminError !== undefined) {
        throw sbHarness.adminError;
      }
      return { activeMessageCount: sbHarness.queueDepth };
    }
  }
  return { ServiceBusClient, ServiceBusAdministrationClient };
});

vi.mock("@azure/identity", () => {
  class ClientSecretCredential {
    constructor(
      public tenantId: string,
      public clientId: string,
      public secret: string,
    ) {}
    async close(): Promise<void> {}
  }
  class ManagedIdentityCredential {
    constructor(public opts?: { clientId?: string }) {}
    async close(): Promise<void> {}
  }
  return { ClientSecretCredential, ManagedIdentityCredential };
});

describe("AzureServiceBusBackend", () => {
  beforeEach(() => {
    sbHarness.receivers = [];
    sbHarness.senders = [];
    sbHarness.receiveScript = [];
    sbHarness.lastClientArgs = [];
    sbHarness.clientClosed = false;
    sbHarness.failNextClientCreations = 0;
    sbHarness.batchMaxMessages = undefined;
    sbHarness.nextSenderFailSend = undefined;
    sbHarness.nextReceiverFailReceive = undefined;
    sbHarness.acceptSessionCalls = [];
    sbHarness.nextAcceptSessionError = undefined;
    sbHarness.sessionsAvailable = 0;
    sbHarness.adminArgs = [];
    sbHarness.queueDepth = 0;
    sbHarness.adminError = undefined;
  });

  function makeAzure(): Promise<MessagingBackend> {
    return getQueue("azure_service_bus", {
      connectionString: "Endpoint=sb://ns.servicebus.windows.net/;Shared...",
      queueName: "jobs",
    });
  }

  it("send serializes the body and closes the sender", async () => {
    const b = await makeAzure();
    await b.send({ a: 1 });
    expect(sbHarness.senders).toHaveLength(1);
    expect(sbHarness.senders[0].sent).toEqual([{ body: JSON.stringify({ a: 1 }) }]);
    expect(sbHarness.senders[0].closed).toBe(true);
    await b.close();
  });

  it("send with delay schedules the message", async () => {
    const b = await makeAzure();
    await b.send({ a: 1 }, 30);
    expect(sbHarness.senders[0].scheduled).toHaveLength(1);
    expect(sbHarness.senders[0].sent).toHaveLength(0);
    await b.close();
  });

  it("sendBatch sends multiple Service Bus batches when the current batch fills", async () => {
    const b = await makeAzure();
    sbHarness.batchMaxMessages = 2;

    const ids = await b.sendBatch([{ n: 1 }, { n: 2 }, { n: 3 }]);

    expect(ids).toEqual(["", "", ""]);
    expect(sbHarness.senders[0].sent).toHaveLength(2);
    expect(sbHarness.senders[0].sent[0]).toMatchObject({
      messages: [{ body: JSON.stringify({ n: 1 }) }, { body: JSON.stringify({ n: 2 }) }],
    });
    expect(sbHarness.senders[0].sent[1]).toMatchObject({
      messages: [{ body: JSON.stringify({ n: 3 }) }],
    });
    await b.close();
  });

  it("sendBatch throws when one message cannot fit in an empty batch", async () => {
    const b = await makeAzure();
    sbHarness.batchMaxMessages = 0;

    await expect(b.sendBatch([{ n: 1 }])).rejects.toBeInstanceOf(MessageSendError);
    expect(sbHarness.senders[0].sent).toHaveLength(0);
    await b.close();
  });

  it("receive maps messages, tracks lock tokens, and delete completes + closes the receiver", async () => {
    const b = await makeAzure();
    sbHarness.receiveScript = [
      [
        {
          lockToken: "lt-1",
          messageId: "m1",
          body: JSON.stringify({ n: 1 }),
          sequenceNumber: 5,
          enqueuedTimeUtc: "2026-01-01",
        },
      ],
    ];

    const msgs = await b.receive(1, 0);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      id: "m1",
      body: { n: 1 },
      receiptHandle: "lt-1",
    });

    const receiver = sbHarness.receivers[0];
    expect(receiver.closed).toBe(false);

    await b.delete("lt-1");
    expect(receiver.completed).toHaveLength(1);
    // last token acked -> receiver closed
    expect(receiver.closed).toBe(true);

    await b.close();
  });

  it("delete with an unknown receipt handle throws MessagingError", async () => {
    const b = await makeAzure();
    await expect(b.delete("nope")).rejects.toBeInstanceOf(MessagingError);
    await b.close();
  });

  it("receive returns [] and closes the receiver when empty", async () => {
    const b = await makeAzure();
    sbHarness.receiveScript = [[]];
    const msgs = await b.receive(5, 1);
    expect(msgs).toEqual([]);
    expect(sbHarness.receivers[0].closed).toBe(true);
    await b.close();
  });

  it("purge drains until empty then closes the receiver", async () => {
    const b = await makeAzure();
    // createReceiver builds ONE FakeReceiver whose own internal script drains;
    // purge() loops on that single receiver, so seed its first batch via the
    // harness and rely on the FakeReceiver returning [] thereafter.
    sbHarness.receiveScript = [[{ lockToken: "a" }, { lockToken: "b" }]];
    await b.purge();
    const receiver = sbHarness.receivers[0];
    expect(receiver.completed).toHaveLength(2);
    expect(receiver.closed).toBe(true);
    await b.close();
  });

  it("close() closes the underlying client", async () => {
    const b = await makeAzure();
    await b.send({ x: 1 });
    await b.close();
    expect(sbHarness.clientClosed).toBe(true);
  });

  it("retries lazy client creation after the first initialization fails", async () => {
    const b = await makeAzure();
    sbHarness.failNextClientCreations = 1;

    await expect(b.send({ attempt: 1 })).rejects.toThrow(/service bus init unavailable/);
    await expect(b.send({ attempt: 2 })).resolves.toBe("");

    expect(sbHarness.senders).toHaveLength(1);
    expect(sbHarness.senders[0].sent).toEqual([{ body: JSON.stringify({ attempt: 2 }) }]);
    await b.close();
  });
});

describe("AzureServiceBusBackend credential validation (azureBus.ts:97)", () => {
  it("throws MessagingError when neither connectionString nor fullyQualifiedNamespace is provided", () => {
    // fromManagedIdentity forwards fullyQualifiedNamespace verbatim; leaving it
    // out yields an init with neither credential source -> guard must throw.
    expect(() => AzureServiceBusBackend.fromManagedIdentity({ queueName: "q" } as never)).toThrow(
      MessagingError,
    );
    expect(() => AzureServiceBusBackend.fromManagedIdentity({ queueName: "q" } as never)).toThrow(
      /Provide either connectionString or fullyQualifiedNamespace/,
    );
  });

  it("succeeds when only connectionString is provided", () => {
    const b = AzureServiceBusBackend.fromConnectionString({
      connectionString: "Endpoint=sb://x/;Shared...",
      queueName: "q",
    });
    expect(b).toBeInstanceOf(AzureServiceBusBackend);
  });

  it("succeeds when only fullyQualifiedNamespace is provided", () => {
    const b = AzureServiceBusBackend.fromManagedIdentity({
      fullyQualifiedNamespace: "ns.servicebus.windows.net",
      queueName: "q",
    });
    expect(b).toBeInstanceOf(AzureServiceBusBackend);
  });
});

describe("AzureServiceBusBackend close credential cleanup (azureBus.ts:202)", () => {
  beforeEach(() => {
    sbHarness.receivers = [];
    sbHarness.senders = [];
    sbHarness.receiveScript = [];
    sbHarness.lastClientArgs = [];
    sbHarness.clientClosed = false;
    sbHarness.failNextClientCreations = 0;
    sbHarness.batchMaxMessages = undefined;
    sbHarness.nextSenderFailSend = undefined;
    sbHarness.nextReceiverFailReceive = undefined;
    sbHarness.acceptSessionCalls = [];
    sbHarness.nextAcceptSessionError = undefined;
    sbHarness.sessionsAvailable = 0;
    sbHarness.adminArgs = [];
    sbHarness.queueDepth = 0;
    sbHarness.adminError = undefined;
  });

  it("calls credential.close() when a credential with close() was created", async () => {
    // Service-principal path builds a ClientSecretCredential (has close()).
    const b = await getQueue("azure_service_bus", {
      fullyQualifiedNamespace: "ns.servicebus.windows.net",
      queueName: "q",
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
    });
    // Force lazy client creation so the credential is instantiated.
    await b.send({ x: 1 });
    const credential = (b as unknown as { credential?: { close: () => Promise<void> } })
      .credential!;
    const spy = vi.spyOn(credential, "close");
    await b.close();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("getQueueDepth reuses the data-plane credential instead of minting a new one (azure_bus.py:388)", async () => {
    // Service-principal path: getQueueDepth must reuse this.credential (the same
    // instance built for the data-plane client) rather than calling the
    // credentialFactory again and leaking a fresh credential per call.
    const b = await getQueue("azure_service_bus", {
      fullyQualifiedNamespace: "ns.servicebus.windows.net",
      queueName: "q",
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
    });
    // Force lazy client creation so this.credential is populated.
    await b.send({ x: 1 });
    const credential = (b as unknown as { credential?: unknown }).credential;
    expect(credential).toBeDefined();

    sbHarness.queueDepth = 5;
    expect(await b.getQueueDepth()).toBe(5);
    // The admin client was constructed with [namespace, reusedCredential].
    expect(sbHarness.adminArgs[0]).toBe("ns.servicebus.windows.net");
    expect(sbHarness.adminArgs[1]).toBe(credential);
    await b.close();
  });

  it("does not throw on close() when no credential is present (connection-string path)", async () => {
    const b = await getQueue("azure_service_bus", {
      connectionString: "Endpoint=sb://ns.servicebus.windows.net/;Shared...",
      queueName: "q",
    });
    await b.send({ x: 1 });
    expect((b as unknown as { credential?: unknown }).credential).toBeUndefined();
    await expect(b.close()).resolves.toBeUndefined();
  });
});

describe("AzureServiceBusBackend sendBatch batchSize boundary (azureBus.ts:254)", () => {
  beforeEach(() => {
    sbHarness.receivers = [];
    sbHarness.senders = [];
    sbHarness.receiveScript = [];
    sbHarness.lastClientArgs = [];
    sbHarness.clientClosed = false;
    sbHarness.failNextClientCreations = 0;
    sbHarness.batchMaxMessages = undefined;
    sbHarness.nextSenderFailSend = undefined;
    sbHarness.nextReceiverFailReceive = undefined;
    sbHarness.acceptSessionCalls = [];
    sbHarness.nextAcceptSessionError = undefined;
    sbHarness.sessionsAvailable = 0;
    sbHarness.adminArgs = [];
    sbHarness.queueDepth = 0;
    sbHarness.adminError = undefined;
  });

  function makeConn(): Promise<MessagingBackend> {
    return getQueue("azure_service_bus", {
      connectionString: "Endpoint=sb://ns.servicebus.windows.net/;Shared...",
      queueName: "jobs",
    });
  }

  it("does NOT send the trailing batch when nothing was accumulated (batchSize 0)", async () => {
    const b = await makeConn();
    const ids = await b.sendBatch([]);
    expect(ids).toEqual([]);
    // batchSize stays 0 -> no sendMessages of the trailing batch.
    expect(sbHarness.senders[0].sent).toHaveLength(0);
    await b.close();
  });

  it("sends the trailing batch when messages were accumulated (batchSize > 0)", async () => {
    const b = await makeConn();
    const ids = await b.sendBatch([{ n: 1 }, { n: 2 }]);
    expect(ids).toEqual(["", ""]);
    // batchSize is 2 -> trailing batch IS sent exactly once.
    expect(sbHarness.senders[0].sent).toHaveLength(1);
    expect(sbHarness.senders[0].sent[0]).toMatchObject({
      messages: [{ body: JSON.stringify({ n: 1 }) }, { body: JSON.stringify({ n: 2 }) }],
    });
    await b.close();
  });
});

describe("AzureServiceBusBackend message construction and mapping", () => {
  beforeEach(() => {
    sbHarness.receivers = [];
    sbHarness.senders = [];
    sbHarness.receiveScript = [];
    sbHarness.lastClientArgs = [];
    sbHarness.clientClosed = false;
    sbHarness.failNextClientCreations = 0;
    sbHarness.batchMaxMessages = undefined;
    sbHarness.nextSenderFailSend = undefined;
    sbHarness.nextReceiverFailReceive = undefined;
    sbHarness.acceptSessionCalls = [];
    sbHarness.nextAcceptSessionError = undefined;
    sbHarness.sessionsAvailable = 0;
    sbHarness.adminArgs = [];
    sbHarness.queueDepth = 0;
    sbHarness.adminError = undefined;
  });

  function makeAzure(): Promise<MessagingBackend> {
    return getQueue("azure_service_bus", {
      connectionString: "Endpoint=sb://ns.servicebus.windows.net/;Shared...",
      queueName: "jobs",
    });
  }

  it("send returns empty string and uses sendMessages (not schedule) at delay 0 (azureBus.ts:217-223)", async () => {
    const b = await makeAzure();
    const id = await b.send({ a: 1 }, 0);
    expect(id).toBe("");
    expect(sbHarness.senders[0].sent).toEqual([{ body: JSON.stringify({ a: 1 }) }]);
    expect(sbHarness.senders[0].scheduled).toHaveLength(0);
    await b.close();
  });

  it("send with delay schedules at Date.now() + delay*1000 (azureBus.ts:218)", async () => {
    const b = await makeAzure();
    const before = Date.now();
    await b.send({ a: 1 }, 30);
    const after = Date.now();

    expect(sbHarness.senders[0].scheduledArgs).toHaveLength(1);
    const { message, scheduledTime } = sbHarness.senders[0].scheduledArgs[0];
    expect(message).toEqual({ body: JSON.stringify({ a: 1 }) });
    expect(scheduledTime).toBeInstanceOf(Date);
    const ms = (scheduledTime as Date).getTime();
    // delay of 30s => roughly now + 30000ms; bounded by the call window.
    expect(ms).toBeGreaterThanOrEqual(before + 30000);
    expect(ms).toBeLessThanOrEqual(after + 30000);
    await b.close();
  });

  it("receive forwards maxMessages and maxWaitTimeInMs (azureBus.ts:269-270)", async () => {
    const b = await makeAzure();
    sbHarness.receiveScript = [[]];
    await b.receive(4, 2);
    const call = sbHarness.receivers[0].receiveCalls[0];
    expect(call.maxMessages).toBe(4);
    expect(call.options).toEqual({ maxWaitTimeInMs: 2000 });
    await b.close();
  });

  it("receive passes undefined maxWaitTimeInMs when waitTime is 0 (azureBus.ts:270)", async () => {
    const b = await makeAzure();
    sbHarness.receiveScript = [[]];
    await b.receive(1, 0);
    const call = sbHarness.receivers[0].receiveCalls[0];
    expect(call.options).toEqual({ maxWaitTimeInMs: undefined });
    await b.close();
  });

  it("receive maps message attributes with exact defaults (azureBus.ts:283-288)", async () => {
    const b = await makeAzure();
    sbHarness.receiveScript = [
      [
        {
          // no messageId, no lockToken, no sequenceNumber, no enqueuedTimeUtc
          body: JSON.stringify({ k: "v" }),
        },
      ],
    ];

    const msgs = await b.receive(1, 0);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({
      id: "",
      body: { k: "v" },
      receiptHandle: "",
      attributes: {
        sequence_number: null,
        enqueued_time: "",
      },
      // FIFO/session fields default to undefined; receiveCount is deliveryCount+1
      // (delivery_count or 0, per Python).
      groupId: undefined,
      dedupId: undefined,
      receiveCount: 1,
    });
    await b.close();
  });

  it("receive preserves sequence_number and enqueued_time when present (azureBus.ts:287-288)", async () => {
    const b = await makeAzure();
    sbHarness.receiveScript = [
      [
        {
          lockToken: "lt",
          messageId: "m",
          body: JSON.stringify({ k: 1 }),
          sequenceNumber: 99,
          enqueuedTimeUtc: "2026-01-02T03:04:05Z",
        },
      ],
    ];

    const msgs = await b.receive(1, 0);
    expect(msgs[0].attributes).toEqual({
      sequence_number: 99,
      enqueued_time: "2026-01-02T03:04:05Z",
    });
    await b.close();
  });

  it("delete with unknown handle throws the exact MessagingError message (azureBus.ts:304-305)", async () => {
    const b = await makeAzure();
    await expect(b.delete("ghost")).rejects.toThrow(
      `No pending message for receipt handle: ${JSON.stringify("ghost")}. ` +
        "Call receive() first and use the returned receiptHandle.",
    );
    await b.close();
  });

  it("parseBody passes a non-string object body through unchanged (azureBus.ts:392)", async () => {
    const b = await makeAzure();
    sbHarness.receiveScript = [[{ lockToken: "lt", messageId: "m", body: { already: "object" } }]];

    const msgs = await b.receive(1, 0);
    expect(msgs[0].body).toEqual({ already: "object" });
    await b.close();
  });

  it("send maps a MessagingEntityNotFound error to QueueNotFoundError (azureBus.ts:367-368)", async () => {
    const b = await makeAzure();
    const cause = Object.assign(new Error("missing"), { code: "MessagingEntityNotFound" });
    sbHarness.nextSenderFailSend = cause;

    const err = await b.send({ a: 1 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      name: "QueueNotFoundError",
      message: "Queue not found: jobs",
    });
    expect((err as Error).cause).toBe(cause);
    // the sender is still closed via the finally block
    expect(sbHarness.senders[0].closed).toBe(true);
    await b.close();
  });

  it("send maps a generic error to MessageSendError preserving cause (azureBus.ts:372)", async () => {
    const b = await makeAzure();
    const cause = new Error("amqp blew up");
    sbHarness.nextSenderFailSend = cause;

    const err = await b.send({ a: 1 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MessageSendError);
    expect(err).not.toBeInstanceOf(QueueNotFoundError);
    expect((err as Error).message).toBe("amqp blew up");
    expect((err as Error).cause).toBe(cause);
    await b.close();
  });

  it("receive maps a MessagingEntityNotFound error to QueueNotFoundError and closes the receiver (azureBus.ts:379-380)", async () => {
    const b = await makeAzure();
    const cause = Object.assign(new Error("missing"), { code: "MessagingEntityNotFound" });
    sbHarness.nextReceiverFailReceive = cause;

    const err = await b.receive(1, 0).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      name: "QueueNotFoundError",
      message: "Queue not found: jobs",
    });
    expect((err as Error).cause).toBe(cause);
    // the receiver is closed in the catch block
    expect(sbHarness.receivers[0].closed).toBe(true);
    await b.close();
  });

  it("receive maps a generic error to MessagingError preserving cause (azureBus.ts:384)", async () => {
    const b = await makeAzure();
    const cause = new Error("recv failed");
    sbHarness.nextReceiverFailReceive = cause;

    const err = await b.receive(1, 0).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MessagingError);
    expect(err).not.toBeInstanceOf(QueueNotFoundError);
    expect((err as Error).message).toBe("recv failed");
    expect((err as Error).cause).toBe(cause);
    expect(sbHarness.receivers[0].closed).toBe(true);
    await b.close();
  });

  it("delete maps a completeMessage failure to MessagingError (azureBus.ts:312-313)", async () => {
    const b = await makeAzure();
    sbHarness.receiveScript = [[{ lockToken: "lt-x", messageId: "m", body: JSON.stringify({}) }]];
    await b.receive(1, 0);
    const cause = new Error("settle failed");
    sbHarness.receivers[0].failComplete = cause;

    const err = await b.delete("lt-x").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MessagingError);
    expect((err as Error).message).toBe("settle failed");
    expect((err as Error).cause).toBe(cause);
    await b.close();
  });
});

describe("AzureServiceBusBackend sessions + nack + dead-letter + depth", () => {
  beforeEach(() => {
    sbHarness.receivers = [];
    sbHarness.senders = [];
    sbHarness.receiveScript = [];
    sbHarness.lastClientArgs = [];
    sbHarness.clientClosed = false;
    sbHarness.failNextClientCreations = 0;
    sbHarness.batchMaxMessages = undefined;
    sbHarness.nextSenderFailSend = undefined;
    sbHarness.nextReceiverFailReceive = undefined;
    sbHarness.acceptSessionCalls = [];
    sbHarness.nextAcceptSessionError = undefined;
    sbHarness.sessionsAvailable = 0;
    sbHarness.adminArgs = [];
    sbHarness.queueDepth = 0;
    sbHarness.adminError = undefined;
  });

  function makeConn(sessionEnabled = false): Promise<MessagingBackend> {
    return getQueue("azure_service_bus", {
      connectionString: "Endpoint=sb://ns.servicebus.windows.net/;Shared...",
      queueName: "jobs",
      sessionEnabled,
    });
  }

  it("send requires groupId on a session-enabled queue and maps it to sessionId", async () => {
    const b = await makeConn(true);
    await expect(b.send({ a: 1 })).rejects.toBeInstanceOf(MessageSendError);

    await b.send({ a: 1 }, 0, { groupId: "s1", dedupId: "d1" });
    expect(sbHarness.senders[0].sent[0]).toEqual({
      body: JSON.stringify({ a: 1 }),
      sessionId: "s1",
      messageId: "d1",
    });
    await b.close();
  });

  it("receive on a session queue accepts a specific session and surfaces FIFO fields", async () => {
    const b = await makeConn(true);
    sbHarness.sessionsAvailable = 1;
    sbHarness.receiveScript = [
      [
        {
          lockToken: "lt",
          messageId: "mid",
          body: JSON.stringify({ n: 1 }),
          sessionId: "s1",
          deliveryCount: 2,
        },
      ],
    ];

    const [msg] = await b.receive(1, 0, { groupId: "s1" });
    expect(sbHarness.acceptSessionCalls[0]).toMatchObject({ queueName: "jobs", sessionId: "s1" });
    expect(msg.groupId).toBe("s1");
    expect(msg.dedupId).toBe("mid");
    expect(msg.receiveCount).toBe(3);
    await b.close();
  });

  it("receive on a session queue with no group accepts the next session", async () => {
    const b = await makeConn(true);
    sbHarness.sessionsAvailable = 1;
    sbHarness.receiveScript = [[]];
    await b.receive(1, 0);
    expect(sbHarness.acceptSessionCalls[0]).toMatchObject({
      queueName: "jobs",
      sessionId: undefined,
    });
    await b.close();
  });

  it("receive returns [] when no session is available (ServiceTimeout)", async () => {
    const b = await makeConn(true);
    sbHarness.sessionsAvailable = 0; // acceptNextSession throws ServiceTimeout
    const msgs = await b.receive(1, 0);
    expect(msgs).toEqual([]);
    await b.close();
  });

  it("receive with groupId on a non-session queue throws FeatureNotSupportedError", async () => {
    const b = await makeConn(false);
    await expect(b.receive(1, 0, { groupId: "s1" })).rejects.toBeInstanceOf(
      FeatureNotSupportedError,
    );
    await b.close();
  });

  it("nack abandons the message and releases the receiver", async () => {
    const b = await makeConn(false);
    sbHarness.receiveScript = [[{ lockToken: "lt", messageId: "m", body: JSON.stringify({}) }]];
    await b.receive(1, 0);
    await b.nack("lt");
    expect(sbHarness.receivers[0].abandoned).toHaveLength(1);
    expect(sbHarness.receivers[0].closed).toBe(true);
    // pending consumed
    await expect(b.delete("lt")).rejects.toThrow(/No pending message/);
    await b.close();
  });

  it("deadLetter dead-letters the message with the reason and releases the receiver", async () => {
    const b = await makeConn(false);
    sbHarness.receiveScript = [[{ lockToken: "lt", messageId: "m", body: JSON.stringify({}) }]];
    await b.receive(1, 0);
    await b.deadLetter("lt", "poison");
    expect(sbHarness.receivers[0].deadLettered).toHaveLength(1);
    expect(sbHarness.receivers[0].deadLettered[0].options).toEqual({
      deadLetterReason: "poison",
      deadLetterErrorDescription: "poison",
    });
    expect(sbHarness.receivers[0].closed).toBe(true);
    await expect(b.deadLetter("lt", "again")).rejects.toThrow(/No pending message/);
    await b.close();
  });

  it("nack with an unknown receipt handle throws MessagingError", async () => {
    const b = await makeConn(false);
    await expect(b.nack("ghost")).rejects.toBeInstanceOf(MessagingError);
    await b.close();
  });

  it("getQueueDepth reads activeMessageCount via the administration client", async () => {
    const b = await makeConn(false);
    sbHarness.queueDepth = 17;
    expect(await b.getQueueDepth()).toBe(17);
    // connection-string path constructs the admin client with the connection string
    expect(sbHarness.adminArgs[0]).toContain("Endpoint=sb://");
    await b.close();
  });

  it("getQueueDepth maps an admin error to MessagingError", async () => {
    const b = await makeConn(false);
    sbHarness.adminError = new Error("admin boom");
    await expect(b.getQueueDepth()).rejects.toBeInstanceOf(MessagingError);
    await b.close();
  });

  it("receive on a non-session queue returns [] when receiveMessages times out (azure_bus.py:291)", async () => {
    // The data-plane receive can itself time out (Python OperationTimeoutError).
    // The JS SDK surfaces this as a ServiceBusError code ServiceTimeout; the
    // backend must treat it as an empty poll, not an error.
    const b = await makeConn(false);
    sbHarness.nextReceiverFailReceive = Object.assign(new Error("recv timed out"), {
      code: "ServiceTimeout",
    });
    const msgs = await b.receive(1, 0);
    expect(msgs).toEqual([]);
    // the receiver is still closed before returning.
    expect(sbHarness.receivers[0].closed).toBe(true);
    await b.close();
  });

  it("purge on a session queue drains sessions until none remain", async () => {
    const b = await makeConn(true);
    sbHarness.sessionsAvailable = 2;
    // first session yields one batch then empties; second yields nothing.
    sbHarness.receiveScript = [[{ lockToken: "a" }], []];
    await b.purge();
    // two sessions accepted + a third accept attempt that times out -> stop
    expect(sbHarness.acceptSessionCalls).toHaveLength(3);
    expect(sbHarness.receivers).toHaveLength(2);
    expect(sbHarness.receivers.every((r) => r.closed)).toBe(true);
    await b.close();
  });
});

describe("getQueue Azure dispatch precedence", () => {
  it("connectionString wins", async () => {
    const b = await getQueue("azure_service_bus", {
      connectionString: "Endpoint=sb://x/;Shared...",
      queueName: "q",
      clientSecret: "s",
      tenantId: "t",
      clientId: "c",
      fullyQualifiedNamespace: "ns",
    });
    expect(b).toBeInstanceOf(AzureServiceBusBackend);
    await b.close();
  });

  it("clientSecret -> service principal", async () => {
    const b = await getQueue("azure_service_bus", {
      fullyQualifiedNamespace: "ns.servicebus.windows.net",
      queueName: "q",
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
    });
    expect(b).toBeInstanceOf(AzureServiceBusBackend);
    await b.close();
  });

  it("falls back to managed identity", async () => {
    const b = await getQueue("azure_service_bus", {
      fullyQualifiedNamespace: "ns.servicebus.windows.net",
      queueName: "q",
    });
    expect(b).toBeInstanceOf(AzureServiceBusBackend);
    await b.close();
  });
});

describe("getQueue", () => {
  beforeEach(() => {
    sqsMock.reset();
  });

  it("dispatches sqs + access key to AWSSQSBackend", async () => {
    const b = await getQueue("sqs", {
      queueUrl: QUEUE_URL,
      awsAccessKeyId: "test",
      awsSecretAccessKey: "test",
      region: "us-east-1",
    });
    expect(b).toBeInstanceOf(AWSSQSBackend);
    await b.close();
  });

  it("dispatches sqs with no credentials to the IAM-role path", async () => {
    const b = await getQueue("sqs", { queueUrl: QUEUE_URL, region: "us-east-1" });
    expect(b).toBeInstanceOf(AWSSQSBackend);
    await b.close();
  });

  it("dispatches sqs + profileName to the profile path", async () => {
    const spy = vi.spyOn(AWSSQSBackend, "fromProfile");
    const b = await getQueue("sqs", {
      queueUrl: QUEUE_URL,
      profileName: "dev",
      region: "us-east-1",
    });
    expect(b).toBeInstanceOf(AWSSQSBackend);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await b.close();
  });

  it("dispatches sqs + access key to the access-key path (not profile/iam)", async () => {
    const accessSpy = vi.spyOn(AWSSQSBackend, "fromAccessKey");
    const profileSpy = vi.spyOn(AWSSQSBackend, "fromProfile");
    const iamSpy = vi.spyOn(AWSSQSBackend, "fromIamRole");
    const b = await getQueue("sqs", {
      queueUrl: QUEUE_URL,
      awsAccessKeyId: "test",
      awsSecretAccessKey: "test",
      region: "us-east-1",
    });
    expect(accessSpy).toHaveBeenCalledTimes(1);
    expect(profileSpy).not.toHaveBeenCalled();
    expect(iamSpy).not.toHaveBeenCalled();
    accessSpy.mockRestore();
    profileSpy.mockRestore();
    iamSpy.mockRestore();
    await b.close();
  });

  it("dispatches azure connectionString to fromConnectionString", async () => {
    const spy = vi.spyOn(AzureServiceBusBackend, "fromConnectionString");
    const b = await getQueue("azure_service_bus", {
      connectionString: "Endpoint=sb://x/;Shared...",
      queueName: "q",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await b.close();
  });

  it("dispatches azure clientSecret to fromServicePrincipal", async () => {
    const spy = vi.spyOn(AzureServiceBusBackend, "fromServicePrincipal");
    const b = await getQueue("azure_service_bus", {
      fullyQualifiedNamespace: "ns.servicebus.windows.net",
      queueName: "q",
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await b.close();
  });

  it("dispatches azure with no credentials to fromManagedIdentity", async () => {
    const spy = vi.spyOn(AzureServiceBusBackend, "fromManagedIdentity");
    const b = await getQueue("azure_service_bus", {
      fullyQualifiedNamespace: "ns.servicebus.windows.net",
      queueName: "q",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await b.close();
  });

  it("normalizes provider values from config", async () => {
    const sqs = await getQueue(" SQS ", { queueUrl: QUEUE_URL, region: "us-east-1" });
    expect(sqs).toBeInstanceOf(AWSSQSBackend);
    await sqs.close();

    const azure = await getQueue(" AZURE_BUS ", {
      fullyQualifiedNamespace: "ns.servicebus.windows.net",
      queueName: "q",
    });
    expect(azure).toBeInstanceOf(AzureServiceBusBackend);
    await azure.close();
  });

  it("rejects fuzzy provider spellings from config", () => {
    expect(() => getQueue(" AZURE SERVICE BUS ", { queueUrl: "x" })).toThrow(
      /Unknown messaging provider/,
    );
  });

  it("throws on an unknown provider", () => {
    expect(() => getQueue("rabbitmq" as never, { queueUrl: "x" })).toThrow(
      /Unknown messaging provider/,
    );
  });
});
