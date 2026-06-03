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
import { MessageSendError, MessagingError } from "../src/core/errors.js";
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

/* ------------------------------------------------------------------ */
/* Azure Service Bus — driven through a mocked @azure/service-bus SDK   */
/* ------------------------------------------------------------------ */

// A controllable fake receiver. Each receiveMessages() call drains one batch
// from a queued script of message batches.
class FakeReceiver {
  closed = false;
  completed: unknown[] = [];
  private batches: Array<Array<Record<string, unknown>>>;

  constructor(batches: Array<Array<Record<string, unknown>>>) {
    this.batches = batches;
  }

  async receiveMessages(): Promise<Array<Record<string, unknown>>> {
    return this.batches.shift() ?? [];
  }

  async completeMessage(msg: unknown): Promise<void> {
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

  async sendMessages(m: unknown): Promise<void> {
    this.sent.push(m);
  }

  async scheduleMessages(m: unknown): Promise<void> {
    this.scheduled.push(m);
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
  batchMaxMessages?: number;
} = {
  receivers: [],
  senders: [],
  receiveScript: [],
  lastClientArgs: [],
  clientClosed: false,
  batchMaxMessages: undefined,
};

vi.mock("@azure/service-bus", () => {
  class ServiceBusClient {
    constructor(...args: unknown[]) {
      sbHarness.lastClientArgs = args;
    }
    createReceiver(): FakeReceiver {
      const r = new FakeReceiver([sbHarness.receiveScript.shift() ?? []]);
      sbHarness.receivers.push(r);
      return r;
    }
    createSender(): FakeSender {
      const s = new FakeSender();
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
    constructor(public tenantId: string, public clientId: string, public secret: string) {}
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
    sbHarness.batchMaxMessages = undefined;
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
      messages: [
        { body: JSON.stringify({ n: 1 }) },
        { body: JSON.stringify({ n: 2 }) },
      ],
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
    sbHarness.receiveScript = [
      [{ lockToken: "a" }, { lockToken: "b" }],
    ];
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

  it("throws on an unknown provider", () => {
    expect(() => getQueue("rabbitmq" as never, { queueUrl: "x" })).toThrow(
      /Unknown messaging provider/,
    );
  });
});
