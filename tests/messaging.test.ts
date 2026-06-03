import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SQSClient,
  SendMessageCommand,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  PurgeQueueCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";

import { getQueue } from "../src/messaging/index.js";
import { AWSSQSBackend } from "../src/messaging/sqs.js";
import { MessageSendError } from "../src/core/errors.js";
import type { MessagingBackend } from "../src/messaging/base.js";

const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue";

const sqsMock = mockClient(SQSClient);

function makeBackend(): MessagingBackend {
  return AWSSQSBackend.fromAccessKey({
    queueUrl: QUEUE_URL,
    awsAccessKeyId: "test",
    awsSecretAccessKey: "test",
    region: "us-east-1",
  });
}

describe("AWSSQSBackend", () => {
  let backend: MessagingBackend;

  beforeEach(() => {
    sqsMock.reset();
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
      DelaySeconds: 0,
    });
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

  it("sendBatch throws MessageSendError when an entry fails", async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({
      Successful: [{ Id: "0", MessageId: "a", MD5OfMessageBody: "x" }],
      Failed: [
        { Id: "1", SenderFault: true, Code: "InternalError", Message: "boom" },
      ],
    });

    await expect(backend.sendBatch([{ n: 1 }, { n: 2 }])).rejects.toBeInstanceOf(
      MessageSendError,
    );
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
    sqsMock
      .on(GetQueueAttributesCommand)
      .resolves({ Attributes: { QueueArn: "arn:aws:sqs:..." } });

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

  it("throws on an unknown provider", () => {
    expect(() => getQueue("rabbitmq" as never, { queueUrl: "x" })).toThrow(
      /Unknown messaging provider/,
    );
  });
});
