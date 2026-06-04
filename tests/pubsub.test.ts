import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SNSClient,
  PublishCommand,
  PublishBatchCommand,
  ListTopicsCommand,
} from "@aws-sdk/client-sns";

import { AWSSNSBackend, AzureEventGridBackend, getPubsub } from "../src/pubsub/index.js";
import { PubSubBackend } from "../src/pubsub/base.js";
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

/* ------------------------------------------------------------------ */
/* PubSubBackend abstract base default methods                          */
/* ------------------------------------------------------------------ */

class MinimalPubSubBackend extends PubSubBackend {
  publish(): Promise<string> {
    return Promise.resolve("id");
  }
  publishBatch(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

describe("PubSubBackend base defaults", () => {
  it("healthCheck defaults to true", async () => {
    const b = new MinimalPubSubBackend();
    expect(await b.healthCheck()).toBe(true);
  });

  it("close defaults to a resolved no-op", async () => {
    const b = new MinimalPubSubBackend();
    await expect(b.close()).resolves.toBeUndefined();
  });

  it("Symbol.asyncDispose delegates to close", async () => {
    const b = new MinimalPubSubBackend();
    const spy = vi.spyOn(b, "close");
    await b[Symbol.asyncDispose]();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("AWSSNSBackend.publish", () => {
  it("returns the MessageId", async () => {
    snsMock.on(PublishCommand).resolves({ MessageId: "msg-123" });
    const backend = await makeBackend();
    const id = await backend.publish(TOPIC, "hello world");
    expect(id).toBe("msg-123");
    expect(typeof id).toBe("string");
    await backend.close();
  });

  it("sends TopicArn + Message and omits MessageAttributes when none given", async () => {
    snsMock.on(PublishCommand).resolves({ MessageId: "msg-plain" });
    const backend = await makeBackend();
    await backend.publish(TOPIC, "plain body");
    const input = snsMock.commandCalls(PublishCommand)[0]!.args[0].input;
    expect(input.TopicArn).toBe(TOPIC);
    expect(input.Message).toBe("plain body");
    expect(input.MessageAttributes).toBeUndefined();
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

  it("wires distinct per-chunk entry IDs and message bodies", async () => {
    snsMock.on(PublishBatchCommand).callsFake((input) => {
      const entries = input.PublishBatchRequestEntries as Array<{ Id: string }>;
      return {
        Successful: entries.map((e) => ({ Id: e.Id, MessageId: `mid-${e.Id}` })),
        Failed: [],
      };
    });
    const backend = await makeBackend();
    // 12 messages -> 2 chunks (10 + 2). Ids reset to "0".. within each chunk.
    const messages = Array.from({ length: 12 }, (_, i) => ({ message: `body-${i}` }));
    await backend.publishBatch(TOPIC, messages);

    const calls = snsMock.commandCalls(PublishBatchCommand);
    expect(calls).toHaveLength(2);

    const first = calls[0]!.args[0].input;
    expect(first.TopicArn).toBe(TOPIC);
    const firstEntries = first.PublishBatchRequestEntries!;
    expect(firstEntries.map((e) => e.Id)).toEqual(Array.from({ length: 10 }, (_, j) => String(j)));
    expect(firstEntries.map((e) => e.Message)).toEqual(
      Array.from({ length: 10 }, (_, j) => `body-${j}`),
    );
    // Ids are distinct within a chunk.
    expect(new Set(firstEntries.map((e) => e.Id)).size).toBe(10);

    const second = calls[1]!.args[0].input;
    const secondEntries = second.PublishBatchRequestEntries!;
    expect(secondEntries.map((e) => e.Id)).toEqual(["0", "1"]);
    expect(secondEntries.map((e) => e.Message)).toEqual(["body-10", "body-11"]);
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
  it("returns true when ListTopics succeeds and sends a ListTopicsCommand", async () => {
    snsMock.on(ListTopicsCommand).resolves({ Topics: [] });
    const backend = await makeBackend();
    expect(await backend.healthCheck()).toBe(true);
    const calls = snsMock.commandCalls(ListTopicsCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toMatchObject({ NextToken: "" });
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

  it("healthCheck validates lazy client initialization", async () => {
    const backend = AzureEventGridBackend.fromAccessKey({
      endpoint: "https://topic",
      accessKey: "key",
    });

    await expect(backend.healthCheck()).resolves.toBe(true);
    expect(eventGridHarness.clients).toHaveLength(1);
    await backend.close();
  });

  it("healthCheck returns false when lazy client initialization fails", async () => {
    eventGridHarness.failNextClientCreations = 1;
    const backend = AzureEventGridBackend.fromManagedIdentity({
      endpoint: "https://topic",
      clientId: "managed-client",
    });

    await expect(backend.healthCheck()).resolves.toBe(false);
    expect(eventGridHarness.clients).toHaveLength(0);
    expect(eventGridHarness.credentials).toHaveLength(1);
    expect(eventGridHarness.credentials[0].closed).toBe(true);
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

/* ------------------------------------------------------------------ */
/* SNS client config construction (region defaults, endpoint, creds)    */
/* ------------------------------------------------------------------ */

async function clientConfigOf(backend: AWSSNSBackend): Promise<{
  region: string;
  endpoint: unknown;
  credentials: () => Promise<{ accessKeyId: string }>;
}> {
  // The backend lazily creates its SNSClient on first send. Inspect the
  // resolved config of that (mocked) client.
  const c = (backend as unknown as { client: { config: Record<string, unknown> } }).client;
  return c.config as never;
}

describe("AWSSNSBackend client config", () => {
  it("fromAccessKey defaults region to us-east-1 when omitted", async () => {
    snsMock.on(ListTopicsCommand).resolves({ Topics: [] });
    const backend = AWSSNSBackend.fromAccessKey({
      awsAccessKeyId: "a",
      awsSecretAccessKey: "s",
    });
    await backend.healthCheck();
    const cfg = await clientConfigOf(backend);
    expect(await (cfg.region as unknown as () => Promise<string>)()).toBe("us-east-1");
    expect(cfg.endpoint).toBeUndefined();
    await backend.close();
  });

  it("fromIamRole defaults region to us-east-1 when omitted", async () => {
    snsMock.on(ListTopicsCommand).resolves({ Topics: [] });
    const backend = AWSSNSBackend.fromIamRole();
    await backend.healthCheck();
    const cfg = await clientConfigOf(backend);
    expect(await (cfg.region as unknown as () => Promise<string>)()).toBe("us-east-1");
    await backend.close();
  });

  it("fromProfile defaults region to us-east-1 when omitted", async () => {
    snsMock.on(ListTopicsCommand).resolves({ Topics: [] });
    const backend = AWSSNSBackend.fromProfile({ profileName: "dev" });
    await backend.healthCheck();
    const cfg = await clientConfigOf(backend);
    expect(await (cfg.region as unknown as () => Promise<string>)()).toBe("us-east-1");
    await backend.close();
  });

  it("honors an explicit region and endpointUrl over defaults", async () => {
    snsMock.on(ListTopicsCommand).resolves({ Topics: [] });
    const backend = AWSSNSBackend.fromAccessKey({
      awsAccessKeyId: "a",
      awsSecretAccessKey: "s",
      region: "eu-west-1",
      endpointUrl: "http://localhost:4566",
    });
    await backend.healthCheck();
    const cfg = await clientConfigOf(backend);
    expect(await (cfg.region as unknown as () => Promise<string>)()).toBe("eu-west-1");
    // endpointUrl set => cfg.endpoint is defined (a resolver function).
    expect(cfg.endpoint).not.toBeUndefined();
    await backend.close();
  });

  it("wires explicit access-key credentials onto the client", async () => {
    snsMock.on(ListTopicsCommand).resolves({ Topics: [] });
    const backend = AWSSNSBackend.fromAccessKey({
      awsAccessKeyId: "AKIA-test",
      awsSecretAccessKey: "secret-test",
      region: "us-east-1",
    });
    await backend.healthCheck();
    const cfg = await clientConfigOf(backend);
    const creds = await cfg.credentials();
    expect(creds.accessKeyId).toBe("AKIA-test");
    await backend.close();
  });
});

/* ------------------------------------------------------------------ */
/* SNS publish/publishBatch boundary and fallback behavior              */
/* ------------------------------------------------------------------ */

describe("AWSSNSBackend.publish boundaries", () => {
  it("returns empty string when SNS omits MessageId", async () => {
    snsMock.on(PublishCommand).resolves({});
    const backend = await makeBackend();
    const id = await backend.publish(TOPIC, "no-id");
    expect(id).toBe("");
    await backend.close();
  });

  it("omits MessageAttributes when attributes is an empty object", async () => {
    snsMock.on(PublishCommand).resolves({ MessageId: "msg-empty" });
    const backend = await makeBackend();
    await backend.publish(TOPIC, "body", {});
    const input = snsMock.commandCalls(PublishCommand)[0]!.args[0].input;
    expect(input.MessageAttributes).toBeUndefined();
    await backend.close();
  });

  it("translates a NotFound error to TopicNotFoundError with exact message", async () => {
    const err = Object.assign(new Error("nope"), { name: "NotFound" });
    snsMock.on(PublishCommand).rejects(err);
    const backend = await makeBackend();
    await expect(backend.publish(TOPIC, "x")).rejects.toBeInstanceOf(TopicNotFoundError);
    await expect(backend.publish(TOPIC, "x")).rejects.toThrow(`Topic not found: ${TOPIC}`);
    await backend.close();
  });

  it("translates a NotFoundException error to TopicNotFoundError", async () => {
    const err = Object.assign(new Error("nope"), { name: "NotFoundException" });
    snsMock.on(PublishCommand).rejects(err);
    const backend = await makeBackend();
    await expect(backend.publish(TOPIC, "x")).rejects.toBeInstanceOf(TopicNotFoundError);
    await backend.close();
  });

  it("translates AuthorizationError to PubSubError with access-denied message", async () => {
    const err = Object.assign(new Error("denied"), { name: "AuthorizationError" });
    snsMock.on(PublishCommand).rejects(err);
    const backend = await makeBackend();
    await expect(backend.publish(TOPIC, "x")).rejects.toBeInstanceOf(PubSubError);
    await expect(backend.publish(TOPIC, "x")).rejects.toThrow(`Access denied for topic: ${TOPIC}`);
    await backend.close();
  });

  it("translates AuthorizationErrorException to PubSubError access-denied", async () => {
    const err = Object.assign(new Error("denied"), { name: "AuthorizationErrorException" });
    snsMock.on(PublishCommand).rejects(err);
    const backend = await makeBackend();
    await expect(backend.publish(TOPIC, "x")).rejects.toThrow(`Access denied for topic: ${TOPIC}`);
    await backend.close();
  });

  it("translates AccessDenied to PubSubError access-denied", async () => {
    const err = Object.assign(new Error("denied"), { name: "AccessDenied" });
    snsMock.on(PublishCommand).rejects(err);
    const backend = await makeBackend();
    await expect(backend.publish(TOPIC, "x")).rejects.toThrow(`Access denied for topic: ${TOPIC}`);
    await backend.close();
  });

  it("falls back to the raw error message for unmapped codes", async () => {
    const err = Object.assign(new Error("throttled hard"), { name: "ThrottlingException" });
    snsMock.on(PublishCommand).rejects(err);
    const backend = await makeBackend();
    await expect(backend.publish(TOPIC, "x")).rejects.toBeInstanceOf(PubSubError);
    await expect(backend.publish(TOPIC, "x")).rejects.toThrow("throttled hard");
    await backend.close();
  });
});

describe("AWSSNSBackend.publishBatch boundaries", () => {
  it("omits per-entry MessageAttributes when attributes is an empty object", async () => {
    snsMock.on(PublishBatchCommand).callsFake((input) => {
      const entries = input.PublishBatchRequestEntries as Array<{ Id: string }>;
      return { Successful: entries.map((e) => ({ Id: e.Id, MessageId: e.Id })), Failed: [] };
    });
    const backend = await makeBackend();
    await backend.publishBatch(TOPIC, [{ message: "m0", attributes: {} }]);
    const input = snsMock.commandCalls(PublishBatchCommand)[0]!.args[0].input;
    expect(input.PublishBatchRequestEntries![0]!.MessageAttributes).toBeUndefined();
    await backend.close();
  });

  it("pushes empty-string ids for Successful entries missing a MessageId", async () => {
    snsMock.on(PublishBatchCommand).resolves({
      Successful: [{ Id: "0" }],
      Failed: [],
    });
    const backend = await makeBackend();
    const ids = await backend.publishBatch(TOPIC, [{ message: "m0" }]);
    expect(ids).toEqual([""]);
    await backend.close();
  });

  it("throws PublishError with the failed-ids message listing the Failed Ids", async () => {
    snsMock.on(PublishBatchCommand).resolves({
      Successful: [],
      Failed: [{ Id: "0" }, { Id: "1" }] as unknown as never,
    });
    const backend = await makeBackend();
    await expect(backend.publishBatch(TOPIC, [{ message: "a" }, { message: "b" }])).rejects.toThrow(
      'Failed to publish messages: ["0","1"]',
    );
    await backend.close();
  });

  it("makes a single PublishBatch call for exactly 10 messages (no extra chunk)", async () => {
    snsMock.on(PublishBatchCommand).callsFake((input) => {
      const entries = input.PublishBatchRequestEntries as Array<{ Id: string }>;
      return { Successful: entries.map((e) => ({ Id: e.Id, MessageId: e.Id })), Failed: [] };
    });
    const backend = await makeBackend();
    const messages = Array.from({ length: 10 }, (_, i) => ({ message: `m${i}` }));
    await backend.publishBatch(TOPIC, messages);
    expect(snsMock.commandCalls(PublishBatchCommand)).toHaveLength(1);
    await backend.close();
  });

  it("serializes the whole message object when entry.message is absent", async () => {
    snsMock.on(PublishBatchCommand).callsFake((input) => {
      const entries = input.PublishBatchRequestEntries as Array<{ Id: string }>;
      return { Successful: entries.map((e) => ({ Id: e.Id, MessageId: e.Id })), Failed: [] };
    });
    const backend = await makeBackend();
    await backend.publishBatch(TOPIC, [{ attributes: { a: "b" } } as never]);
    const input = snsMock.commandCalls(PublishBatchCommand)[0]!.args[0].input;
    expect(input.PublishBatchRequestEntries![0]!.Message).toBe(
      JSON.stringify({ attributes: { a: "b" } }),
    );
    await backend.close();
  });

  it("translates a non-PublishError chunk failure via translate()", async () => {
    const err = Object.assign(new Error("boom"), { name: "NotFound" });
    snsMock.on(PublishBatchCommand).rejects(err);
    const backend = await makeBackend();
    await expect(backend.publishBatch(TOPIC, [{ message: "m0" }])).rejects.toBeInstanceOf(
      TopicNotFoundError,
    );
    await backend.close();
  });
});

/* ------------------------------------------------------------------ */
/* Azure Event Grid event construction + error mapping detail           */
/* ------------------------------------------------------------------ */

describe("AzureEventGridBackend event construction", () => {
  beforeEach(() => {
    eventGridHarness.clients = [];
    eventGridHarness.credentials = [];
    eventGridHarness.failNextClientCreations = 0;
    eventGridHarness.sendError = undefined;
  });

  it("managed identity without clientId calls the no-arg credential", async () => {
    const backend = AzureEventGridBackend.fromManagedIdentity({ endpoint: "https://topic" });
    await backend.publish("topic", "message");
    expect(eventGridHarness.credentials[0].kind).toBe("managed");
    expect(eventGridHarness.credentials[0].args).toEqual([]);
    await backend.close();
  });

  it("publish builds a CloudEvent with empty extensionAttributes when none given", async () => {
    const backend = AzureEventGridBackend.fromAccessKey({
      endpoint: "https://topic",
      accessKey: "key",
    });
    const id = await backend.publish("orders", "created");
    expect(eventGridHarness.clients[0].sent[0]).toEqual([
      {
        type: "cloudrift.event",
        source: "orders",
        id,
        data: "created",
        extensionAttributes: {},
      },
    ]);
    await backend.close();
  });

  it("publishBatch serializes the whole message when msg.message is absent", async () => {
    const backend = AzureEventGridBackend.fromAccessKey({
      endpoint: "https://topic",
      accessKey: "key",
    });
    const ids = await backend.publishBatch("orders", [{ attributes: { a: "b" } } as never]);
    expect(eventGridHarness.clients[0].sent[0]).toEqual([
      {
        type: "cloudrift.event",
        source: "orders",
        id: ids[0],
        data: JSON.stringify({ attributes: { a: "b" } }),
        extensionAttributes: { a: "b" },
      },
    ]);
    await backend.close();
  });

  it("publishBatch returns one id per message in order", async () => {
    const backend = AzureEventGridBackend.fromAccessKey({
      endpoint: "https://topic",
      accessKey: "key",
    });
    const ids = await backend.publishBatch("orders", [
      { message: "a" },
      { message: "b" },
      { message: "c" },
    ]);
    expect(ids).toHaveLength(3);
    const sent = eventGridHarness.clients[0].sent[0] as Array<{ id: string }>;
    expect(sent.map((e) => e.id)).toEqual(ids);
    await backend.close();
  });

  it("maps a 404 error to TopicNotFoundError with exact message", async () => {
    const backend = AzureEventGridBackend.fromAccessKey({
      endpoint: "https://topic",
      accessKey: "key",
    });
    eventGridHarness.sendError = new FakeRestError(404);
    await expect(backend.publish("missing", "m")).rejects.toThrow("Topic not found: missing");
    await backend.close();
  });

  it("maps a 403 error to PubSubError with access-denied message", async () => {
    const backend = AzureEventGridBackend.fromAccessKey({
      endpoint: "https://topic",
      accessKey: "key",
    });
    eventGridHarness.sendError = new FakeRestError(403);
    await expect(backend.publish("denied", "m")).rejects.toBeInstanceOf(PubSubError);
    await expect(backend.publish("denied", "m")).rejects.toThrow("Access denied for topic: denied");
    await backend.close();
  });

  it("maps a 500 status to PublishError carrying the underlying message", async () => {
    const backend = AzureEventGridBackend.fromAccessKey({
      endpoint: "https://topic",
      accessKey: "key",
    });
    eventGridHarness.sendError = new FakeRestError(500, "server exploded");
    await expect(backend.publish("topic", "m")).rejects.toBeInstanceOf(PublishError);
    await expect(backend.publish("topic", "m")).rejects.toThrow("server exploded");
    await backend.close();
  });

  it("treats a non-Error rejection as PublishError using String(err)", async () => {
    const backend = AzureEventGridBackend.fromAccessKey({
      endpoint: "https://topic",
      accessKey: "key",
    });
    eventGridHarness.sendError = "plain string failure" as unknown as Error;
    await expect(backend.publish("topic", "m")).rejects.toBeInstanceOf(PublishError);
    await expect(backend.publish("topic", "m")).rejects.toThrow("plain string failure");
    await backend.close();
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

  it("dispatches sns + awsAccessKeyId to fromAccessKey", async () => {
    const spy = vi.spyOn(AWSSNSBackend, "fromAccessKey");
    const backend = await getPubsub("sns", {
      awsAccessKeyId: "test",
      awsSecretAccessKey: "test",
      region: "us-east-1",
    });
    expect(backend).toBeInstanceOf(AWSSNSBackend);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await backend.close();
  });

  it("dispatches sns + profileName to fromProfile", async () => {
    const spy = vi.spyOn(AWSSNSBackend, "fromProfile");
    const backend = await getPubsub("sns", { profileName: "dev", region: "us-east-1" });
    expect(backend).toBeInstanceOf(AWSSNSBackend);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await backend.close();
  });

  it("dispatches sns with no credentials to fromIamRole", async () => {
    const accessSpy = vi.spyOn(AWSSNSBackend, "fromAccessKey");
    const profileSpy = vi.spyOn(AWSSNSBackend, "fromProfile");
    const iamSpy = vi.spyOn(AWSSNSBackend, "fromIamRole");
    const backend = await getPubsub("sns", { region: "us-east-1" });
    expect(backend).toBeInstanceOf(AWSSNSBackend);
    expect(iamSpy).toHaveBeenCalledTimes(1);
    expect(accessSpy).not.toHaveBeenCalled();
    expect(profileSpy).not.toHaveBeenCalled();
    accessSpy.mockRestore();
    profileSpy.mockRestore();
    iamSpy.mockRestore();
    await backend.close();
  });

  it("dispatches azure_eventgrid + accessKey to fromAccessKey", async () => {
    eventGridHarness.clients = [];
    eventGridHarness.credentials = [];
    eventGridHarness.failNextClientCreations = 0;
    eventGridHarness.sendError = undefined;
    const spy = vi.spyOn(AzureEventGridBackend, "fromAccessKey");
    const backend = await getPubsub("azure_eventgrid", {
      endpoint: "https://topic",
      accessKey: "key",
    });
    expect(backend).toBeInstanceOf(AzureEventGridBackend);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await backend.close();
  });

  it("dispatches azure_eventgrid + clientSecret to fromServicePrincipal", async () => {
    eventGridHarness.clients = [];
    eventGridHarness.credentials = [];
    eventGridHarness.failNextClientCreations = 0;
    eventGridHarness.sendError = undefined;
    const spy = vi.spyOn(AzureEventGridBackend, "fromServicePrincipal");
    const backend = await getPubsub("azure_eventgrid", {
      endpoint: "https://topic",
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
    });
    expect(backend).toBeInstanceOf(AzureEventGridBackend);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await backend.close();
  });

  it("dispatches azure_eventgrid with no key/secret to fromManagedIdentity", async () => {
    eventGridHarness.clients = [];
    eventGridHarness.credentials = [];
    eventGridHarness.failNextClientCreations = 0;
    eventGridHarness.sendError = undefined;
    const spy = vi.spyOn(AzureEventGridBackend, "fromManagedIdentity");
    const backend = await getPubsub("azure_eventgrid", {
      endpoint: "https://topic",
      clientId: "managed-client",
    });
    expect(backend).toBeInstanceOf(AzureEventGridBackend);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await backend.close();
  });

  it("throws CloudRiftError for an unknown provider", async () => {
    await expect(getPubsub("gcp_pubsub" as never, { project: "my-proj" })).rejects.toBeInstanceOf(
      CloudRiftError,
    );
    await expect(getPubsub("gcp_pubsub" as never, {})).rejects.toThrow(/Unknown pubsub provider/);
  });
});
