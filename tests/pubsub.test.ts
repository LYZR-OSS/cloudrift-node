import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SNSClient,
  PublishCommand,
  PublishBatchCommand,
  ListTopicsCommand,
} from "@aws-sdk/client-sns";

import { AWSSNSBackend, getPubsub } from "../src/pubsub/index.js";
import { PublishError, CloudRiftError } from "../src/core/errors.js";

const TOPIC = "arn:aws:sns:us-east-1:123456789012:test-topic";

const snsMock = mockClient(SNSClient);
const credentialProviderMock = vi.hoisted(() => ({
  fromIni: vi.fn(() => async () => ({
    accessKeyId: "profile-key",
    secretAccessKey: "profile-secret",
  })),
}));

vi.mock("@aws-sdk/credential-providers", () => credentialProviderMock);

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
