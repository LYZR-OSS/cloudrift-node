import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SNSClient,
  PublishCommand,
  PublishBatchCommand,
  ListTopicsCommand,
} from "@aws-sdk/client-sns";

import { AWSSNSBackend, AzureEventGridBackend, getPubsub } from "../src/pubsub/index.js";
import {
  PublishError,
  CloudRiftError,
  PubSubError,
  TopicNotFoundError,
} from "../src/core/errors.js";

const TOPIC = "arn:aws:sns:us-east-1:123456789012:test-topic";

const snsMock = mockClient(SNSClient);
const credentialProviderMock = vi.hoisted(() => ({
  fromIni: vi.fn(() => async () => ({
    accessKeyId: "profile-key",
    secretAccessKey: "profile-secret",
  })),
}));

vi.mock("@aws-sdk/credential-providers", () => credentialProviderMock);

class FakeRestError extends Error {
  statusCode: number;

  constructor(statusCode: number, message = `status ${statusCode}`) {
    super(message);
    this.name = "RestError";
    this.statusCode = statusCode;
  }
}

const eventGridHarness = vi.hoisted(() => ({
  clients: [] as Array<{
    endpoint: string;
    schema: string;
    credential: unknown;
    sent: unknown[][];
    closed: boolean;
  }>,
  credentials: [] as Array<{ kind: string; args: unknown[]; closed: boolean }>,
  failNextClientCreations: 0,
  sendError: undefined as Error | undefined,
}));

vi.mock("@azure/eventgrid", () => {
  class AzureKeyCredential {
    constructor(public key: string) {
      eventGridHarness.credentials.push({ kind: "access-key", args: [key], closed: false });
    }
  }

  class EventGridPublisherClient {
    sent: unknown[][] = [];
    closed = false;

    constructor(
      public endpoint: string,
      public schema: string,
      public credential: unknown,
    ) {
      if (eventGridHarness.failNextClientCreations > 0) {
        eventGridHarness.failNextClientCreations -= 1;
        throw new Error("event grid init unavailable");
      }
      eventGridHarness.clients.push(this);
    }

    async send(events: unknown[]): Promise<void> {
      if (eventGridHarness.sendError !== undefined) {
        throw eventGridHarness.sendError;
      }
      this.sent.push(events);
    }

    async close(): Promise<void> {
      this.closed = true;
    }
  }

  return { AzureKeyCredential, EventGridPublisherClient };
});

vi.mock("@azure/identity", () => {
  class ManagedIdentityCredential {
    record: { kind: string; args: unknown[]; closed: boolean };

    constructor(...args: unknown[]) {
      this.record = { kind: "managed", args, closed: false };
      eventGridHarness.credentials.push(this.record);
    }

    async close(): Promise<void> {
      this.record.closed = true;
    }
  }

  class ClientSecretCredential {
    record: { kind: string; args: unknown[]; closed: boolean };

    constructor(...args: unknown[]) {
      this.record = { kind: "service-principal", args, closed: false };
      eventGridHarness.credentials.push(this.record);
    }

    async close(): Promise<void> {
      this.record.closed = true;
    }
  }

  return { ManagedIdentityCredential, ClientSecretCredential };
});

beforeEach(() => {
  snsMock.reset();
  credentialProviderMock.fromIni.mockClear();
});

afterEach(() => {
  snsMock.reset();
});

async function makeBackend(): Promise<AWSSNSBackend> {
  const backend = await getPubsub("sns", {
    awsAccessKeyId: "test",
    awsSecretAccessKey: "test",
    region: "us-east-1",
  });
  return backend as AWSSNSBackend;
}

describe("AWSSNSBackend.publish", () => {
  it("returns the MessageId", async () => {
    snsMock.on(PublishCommand).resolves({ MessageId: "msg-123" });
    const backend = await makeBackend();
    const id = await backend.publish(TOPIC, "hello world");
    expect(id).toBe("msg-123");
    expect(typeof id).toBe("string");
    await backend.close();
  });

  it("passes attributes through as String DataType, stringified", async () => {
    snsMock.on(PublishCommand).resolves({ MessageId: "msg-attr" });
    const backend = await makeBackend();
    const id = await backend.publish(TOPIC, "event payload", {
      event_type: "test",
      version: "1",
    });
    expect(id).toBe("msg-attr");
    const calls = snsMock.commandCalls(PublishCommand);
    expect(calls.length).toBe(1);
    const input = calls[0]!.args[0].input;
    expect(input.TopicArn).toBe(TOPIC);
    expect(input.Message).toBe("event payload");
    expect(input.MessageAttributes).toEqual({
      event_type: { DataType: "String", StringValue: "test" },
      version: { DataType: "String", StringValue: "1" },
    });
    await backend.close();
  });
});

describe("AWSSNSBackend.publishBatch", () => {
  it("chunks a batch of 25 into 3 PublishBatch calls and returns 25 ids", async () => {
    snsMock.on(PublishBatchCommand).callsFake((input) => {
      const entries = input.PublishBatchRequestEntries as Array<{ Id: string }>;
      return {
        Successful: entries.map((e) => ({ Id: e.Id, MessageId: `mid-${e.Id}` })),
        Failed: [],
      };
    });
    const backend = await makeBackend();
    const messages = Array.from({ length: 25 }, (_, i) => ({ message: `m${i}` }));
    const ids = await backend.publishBatch(TOPIC, messages);
    expect(snsMock.commandCalls(PublishBatchCommand).length).toBe(3);
    expect(ids.length).toBe(25);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    await backend.close();
  });

  it("raises PublishError when a chunk has a Failed entry", async () => {
    snsMock.on(PublishBatchCommand).resolves({
      Successful: [],
      Failed: [{ Id: "0", Code: "InternalError", Message: "boom", SenderFault: false }],
    });
    const backend = await makeBackend();
    await expect(backend.publishBatch(TOPIC, [{ message: "m0" }])).rejects.toBeInstanceOf(
      PublishError,
    );
    await backend.close();
  });

  it("attaches attributes per entry", async () => {
    snsMock.on(PublishBatchCommand).callsFake((input) => {
      const entries = input.PublishBatchRequestEntries as Array<{ Id: string }>;
      return { Successful: entries.map((e) => ({ Id: e.Id, MessageId: e.Id })), Failed: [] };
    });
    const backend = await makeBackend();
    await backend.publishBatch(TOPIC, [
      { message: "msg1", attributes: { seq: "1" } },
      { message: "msg2" },
    ]);
    const input = snsMock.commandCalls(PublishBatchCommand)[0]!.args[0].input;
    const entries = input.PublishBatchRequestEntries!;
    expect(entries[0]!.MessageAttributes).toEqual({
      seq: { DataType: "String", StringValue: "1" },
    });
    expect(entries[1]!.MessageAttributes).toBeUndefined();
    await backend.close();
  });
});

describe("AWSSNSBackend.healthCheck", () => {
  it("returns true when ListTopics succeeds", async () => {
    snsMock.on(ListTopicsCommand).resolves({ Topics: [] });
    const backend = await makeBackend();
    expect(await backend.healthCheck()).toBe(true);
    await backend.close();
  });

  it("returns false when ListTopics fails", async () => {
    snsMock.on(ListTopicsCommand).rejects(new Error("network down"));
    const backend = await makeBackend();
    expect(await backend.healthCheck()).toBe(false);
    await backend.close();
  });

  it("resolves named profiles through fromIni credentials", async () => {
    snsMock.on(ListTopicsCommand).resolves({ Topics: [] });
    const backend = await getPubsub("sns", {
      profileName: "dev",
      region: "us-east-1",
    });

    expect(await backend.healthCheck()).toBe(true);
    expect(credentialProviderMock.fromIni).toHaveBeenCalledWith({ profile: "dev" });
    await backend.close();
  });

  it("retries lazy client creation after a failed profile init", async () => {
    snsMock.on(PublishCommand).resolves({ MessageId: "msg-retry" });
    credentialProviderMock.fromIni
      .mockImplementationOnce(() => {
        throw new Error("profile unavailable");
      })
      .mockReturnValueOnce(async () => ({
        accessKeyId: "retry-key",
        secretAccessKey: "retry-secret",
      }));
    const backend = AWSSNSBackend.fromProfile({
      profileName: "dev",
      region: "us-east-1",
    });

    await expect(backend.publish(TOPIC, "first")).rejects.toThrow(/profile unavailable/);
    await expect(backend.publish(TOPIC, "second")).resolves.toBe("msg-retry");

    expect(credentialProviderMock.fromIni).toHaveBeenCalledTimes(2);
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(1);
    await backend.close();
  });
});

describe("AzureEventGridBackend (fake)", () => {
  beforeEach(() => {
    eventGridHarness.clients = [];
    eventGridHarness.credentials = [];
    eventGridHarness.failNextClientCreations = 0;
    eventGridHarness.sendError = undefined;
  });

  it("dispatches access-key auth and publishes a CloudEvent envelope", async () => {
    const backend = (await getPubsub("azure_eventgrid", {
      endpoint: "https://topic.eastus-1.eventgrid.azure.net/api/events",
      accessKey: "key",
    })) as AzureEventGridBackend;

    const id = await backend.publish("orders", "created", { tenant: "lyzr" });

    expect(id).toEqual(expect.any(String));
    expect(eventGridHarness.credentials[0]).toMatchObject({
      kind: "access-key",
      args: ["key"],
    });
    expect(eventGridHarness.clients[0]).toMatchObject({
      endpoint: "https://topic.eastus-1.eventgrid.azure.net/api/events",
      schema: "CloudEvent",
    });
    expect(eventGridHarness.clients[0].sent[0]).toEqual([
      {
        type: "cloudrift.event",
        source: "orders",
        id,
        data: "created",
        extensionAttributes: { tenant: "lyzr" },
      },
    ]);
    await backend.close();
    expect(eventGridHarness.clients[0].closed).toBe(true);
  });

  it("dispatches managed identity and service principal auth", async () => {
    const managed = await getPubsub("azure_eventgrid", {
      endpoint: "https://topic",
      clientId: "managed-client",
    });
    await managed.publish("topic", "message");
    await managed.close();

    const principal = await getPubsub("azure_eventgrid", {
      endpoint: "https://topic",
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
    });
    await principal.publish("topic", "message");
    await principal.close();

    expect(eventGridHarness.credentials.map((credential) => credential.kind)).toEqual([
      "managed",
      "service-principal",
    ]);
    expect(eventGridHarness.credentials[0].args).toEqual([{ clientId: "managed-client" }]);
    expect(eventGridHarness.credentials[1].args).toEqual(["tenant", "client", "secret"]);
    expect(eventGridHarness.credentials.every((credential) => credential.closed)).toBe(true);
  });

  it("publishes batches as CloudEvents with attributes", async () => {
    const backend = AzureEventGridBackend.fromAccessKey({
      endpoint: "https://topic",
      accessKey: "key",
    });

    const ids = await backend.publishBatch("orders", [
      { message: "created", attributes: { seq: "1" } },
      { message: "updated" },
    ]);

    expect(ids).toHaveLength(2);
    expect(eventGridHarness.clients[0].sent[0]).toEqual([
      {
        type: "cloudrift.event",
        source: "orders",
        id: ids[0],
        data: "created",
        extensionAttributes: { seq: "1" },
      },
      {
        type: "cloudrift.event",
        source: "orders",
        id: ids[1],
        data: "updated",
        extensionAttributes: {},
      },
    ]);
    await backend.close();
  });

  it("maps provider errors", async () => {
    const backend = AzureEventGridBackend.fromAccessKey({
      endpoint: "https://topic",
      accessKey: "key",
    });

    eventGridHarness.sendError = new FakeRestError(404);
    await expect(backend.publish("missing", "message")).rejects.toBeInstanceOf(TopicNotFoundError);

    eventGridHarness.sendError = new FakeRestError(403);
    await expect(backend.publish("denied", "message")).rejects.toBeInstanceOf(PubSubError);

    eventGridHarness.sendError = new Error("boom");
    await expect(backend.publish("failed", "message")).rejects.toBeInstanceOf(PublishError);
    await backend.close();
  });

  it("retries lazy client creation after the first initialization fails", async () => {
    eventGridHarness.failNextClientCreations = 1;
    const backend = AzureEventGridBackend.fromManagedIdentity({
      endpoint: "https://topic",
      clientId: "managed-client",
    });

    await expect(backend.publish("orders", "first")).rejects.toThrow(/event grid init unavailable/);
    await expect(backend.publish("orders", "second")).resolves.toEqual(expect.any(String));

    expect(eventGridHarness.clients).toHaveLength(1);
    expect(eventGridHarness.credentials).toHaveLength(2);
    expect(eventGridHarness.credentials[0].closed).toBe(true);
    expect(eventGridHarness.credentials[1].closed).toBe(false);
    expect(eventGridHarness.clients[0].sent).toHaveLength(1);
    await backend.close();
    expect(eventGridHarness.credentials[1].closed).toBe(true);
  });
});

describe("getPubsub factory", () => {
  it("normalizes provider values from config", async () => {
    const backend = await getPubsub(" SNS ", {
      topicArn: "arn:aws:sns:us-east-1:123456789012:test-topic",
      region: "us-east-1",
    });
    expect(backend).toBeInstanceOf(AWSSNSBackend);
    await backend.close();
  });

  it("throws CloudRiftError for an unknown provider", async () => {
    await expect(getPubsub("gcp_pubsub" as never, { project: "my-proj" })).rejects.toBeInstanceOf(
      CloudRiftError,
    );
    await expect(getPubsub("gcp_pubsub" as never, {})).rejects.toThrow(/Unknown pubsub provider/);
  });
});
