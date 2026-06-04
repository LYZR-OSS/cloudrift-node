import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { AzureServiceBusBackend } from "../src/messaging/azureBus.js";
import { MessageSendError, MessagingError, QueueNotFoundError } from "../src/core/errors.js";
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
/* Azure Service Bus — driven through a mocked @azure/service-bus SDK   */
/* ------------------------------------------------------------------ */

// A controllable fake receiver. Each receiveMessages() call drains one batch
// from a queued script of message batches.
class FakeReceiver {
  closed = false;
  completed: unknown[] = [];
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
    async close(): Promise<void> {
      sbHarness.clientClosed = true;
    }
  }
  return { ServiceBusClient };
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
