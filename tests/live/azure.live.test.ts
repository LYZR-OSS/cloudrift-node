/**
 * Azure live lifecycle tests (Blob, Key Vault, Event Grid, Service Bus).
 *
 * Each describe is gated independently on its own env subset (plus the master
 * CLOUDRIFT_LIVE_TESTS switch). Containers are created-if-permitted via the raw
 * SDK and deleted only when WE created them. All cleanup is wrapped so a
 * cleanup failure never masks a test failure.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BlobServiceClient } from "@azure/storage-blob";

import { getStorage, getSecrets, getPubsub, getQueue } from "../../src/index.js";
import { env, liveLog, requireEnv, uniqueName } from "./env.js";

/* ================================================================== */
/* Blob                                                               */
/* ================================================================== */

const BLOB_PRESENT = requireEnv(["CLOUDRIFT_LIVE_AZURE_STORAGE_CONNECTION_STRING"]);

describe.skipIf(!BLOB_PRESENT)("Azure Blob live lifecycle", () => {
  const log = liveLog("azure:blob");
  const connectionString = env("CLOUDRIFT_LIVE_AZURE_STORAGE_CONNECTION_STRING")!;
  const key = uniqueName("blob");
  const payload = Buffer.from("cloudrift-live-blob-payload", "utf8");

  let container: string;
  let createdContainer = false;
  let backend: Awaited<ReturnType<typeof getStorage>> | undefined;

  beforeAll(async () => {
    const provided = env("CLOUDRIFT_LIVE_AZURE_BLOB_CONTAINER");
    const service = BlobServiceClient.fromConnectionString(connectionString);
    if (provided !== undefined) {
      container = provided;
      log.step("using provided container", { container });
    } else {
      container = uniqueName("container");
      log.step("creating container", { container });
      await service.getContainerClient(container).create();
      createdContainer = true;
      log.step("created container", { container });
    }
    log.step("initializing backend", { provider: "azure_blob", container });
    backend = await getStorage("azure_blob", { connectionString, container });
  });

  afterAll(async () => {
    try {
      await backend?.close();
      log.step("closed backend", { container });
    } catch (err) {
      log.warn("backend close failed", err, { container });
    }
    try {
      if (createdContainer) {
        const service = BlobServiceClient.fromConnectionString(connectionString);
        await service.getContainerClient(container).delete();
        log.step("deleted created container", { container });
      } else {
        log.step("left provided container intact", { container });
      }
    } catch (err) {
      log.warn("cleanup failed", err, { container });
    }
  });

  it("uploads, reads back, and deletes a blob", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    log.step("uploading blob", { container, key });
    await b.upload(key, payload, "text/plain");
    const downloaded = await b.download(key);
    expect(downloaded.equals(payload)).toBe(true);
    log.step("downloaded blob", { container, key, bytes: downloaded.length });

    await b.delete(key);
    expect(await b.exists(key)).toBe(false);
    log.step("deleted blob", { container, key });
  });
});

/* ================================================================== */
/* Key Vault                                                          */
/* ================================================================== */

const KEYVAULT_PRESENT = requireEnv([
  "CLOUDRIFT_LIVE_AZURE_KEYVAULT_URL",
  "CLOUDRIFT_LIVE_AZURE_TENANT_ID",
  "CLOUDRIFT_LIVE_AZURE_CLIENT_ID",
  "CLOUDRIFT_LIVE_AZURE_CLIENT_SECRET",
]);

describe.skipIf(!KEYVAULT_PRESENT)("Azure Key Vault live lifecycle", () => {
  const log = liveLog("azure:keyvault");
  const name = uniqueName("kv-secret");
  let backend: Awaited<ReturnType<typeof getSecrets>> | undefined;

  beforeAll(async () => {
    log.step("initializing backend", {
      provider: "azure_keyvault",
      vaultUrl: env("CLOUDRIFT_LIVE_AZURE_KEYVAULT_URL")!,
      name,
    });
    backend = await getSecrets("azure_keyvault", {
      vaultUrl: env("CLOUDRIFT_LIVE_AZURE_KEYVAULT_URL")!,
      tenantId: env("CLOUDRIFT_LIVE_AZURE_TENANT_ID")!,
      clientId: env("CLOUDRIFT_LIVE_AZURE_CLIENT_ID")!,
      clientSecret: env("CLOUDRIFT_LIVE_AZURE_CLIENT_SECRET")!,
    });
  });

  afterAll(async () => {
    try {
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

  it("sets and reads back a secret", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    const value = "cloudrift-live-kv-value";
    log.step("setting secret", { name });
    await b.setSecret(name, value);
    expect(await b.getSecret(name)).toBe(value);
    log.step("read secret", { name });
  });
});

/* ================================================================== */
/* Event Grid                                                         */
/* ================================================================== */

const EVENTGRID_PRESENT = requireEnv([
  "CLOUDRIFT_LIVE_AZURE_EVENTGRID_ENDPOINT",
  "CLOUDRIFT_LIVE_AZURE_EVENTGRID_KEY",
]);

describe.skipIf(!EVENTGRID_PRESENT)("Azure Event Grid live lifecycle", () => {
  const log = liveLog("azure:eventgrid");
  let backend: Awaited<ReturnType<typeof getPubsub>> | undefined;

  beforeAll(async () => {
    log.step("initializing backend", {
      provider: "azure_eventgrid",
      endpointUrl: env("CLOUDRIFT_LIVE_AZURE_EVENTGRID_ENDPOINT")!,
    });
    backend = await getPubsub("azure_eventgrid", {
      endpoint: env("CLOUDRIFT_LIVE_AZURE_EVENTGRID_ENDPOINT")!,
      accessKey: env("CLOUDRIFT_LIVE_AZURE_EVENTGRID_KEY")!,
    });
  });

  afterAll(async () => {
    try {
      await backend?.close();
      log.step("closed backend");
    } catch (err) {
      log.warn("backend close failed", err);
    }
  });

  it("publishes a single event without throwing and returns an id", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    log.step("publishing event", { topic: "cloudrift/live" });
    const id = await b.publish("cloudrift/live", "cloudrift-live-eventgrid");
    expect(id).toBeTruthy();
    log.step("published event", { topic: "cloudrift/live", eventId: id });
  });
});

/* ================================================================== */
/* Service Bus                                                        */
/* ================================================================== */

const SERVICEBUS_PRESENT = requireEnv([
  "CLOUDRIFT_LIVE_AZURE_SERVICEBUS_CONNECTION_STRING",
  "CLOUDRIFT_LIVE_AZURE_SERVICEBUS_QUEUE",
]);

describe.skipIf(!SERVICEBUS_PRESENT)("Azure Service Bus live lifecycle", () => {
  const log = liveLog("azure:servicebus");
  let backend: Awaited<ReturnType<typeof getQueue>> | undefined;

  beforeAll(async () => {
    log.step("initializing backend", {
      provider: "azure_service_bus",
      queueName: env("CLOUDRIFT_LIVE_AZURE_SERVICEBUS_QUEUE")!,
    });
    backend = await getQueue("azure_service_bus", {
      connectionString: env("CLOUDRIFT_LIVE_AZURE_SERVICEBUS_CONNECTION_STRING")!,
      queueName: env("CLOUDRIFT_LIVE_AZURE_SERVICEBUS_QUEUE")!,
    });
  });

  afterAll(async () => {
    try {
      await backend?.close();
      log.step("closed backend", { queueName: env("CLOUDRIFT_LIVE_AZURE_SERVICEBUS_QUEUE")! });
    } catch (err) {
      log.warn("backend close failed", err, {
        queueName: env("CLOUDRIFT_LIVE_AZURE_SERVICEBUS_QUEUE")!,
      });
    }
  });

  it("sends, receives (bounded wait), and completes a message", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    const marker = uniqueName("sb-msg");
    log.step("sending message", {
      queueName: env("CLOUDRIFT_LIVE_AZURE_SERVICEBUS_QUEUE")!,
      marker,
    });
    await b.send({ marker });

    // Bounded wait via the API's own maxWaitTimeInMs (waitTime seconds here).
    log.step("receiving message", {
      queueName: env("CLOUDRIFT_LIVE_AZURE_SERVICEBUS_QUEUE")!,
      waitSeconds: 20,
    });
    const received = await b.receive(1, 20);
    expect(received.length).toBeGreaterThanOrEqual(1);
    const msg = received[0];
    expect(msg.body).toEqual({ marker });
    log.step("received message", {
      queueName: env("CLOUDRIFT_LIVE_AZURE_SERVICEBUS_QUEUE")!,
      marker,
      count: received.length,
    });

    await b.delete(msg.receiptHandle);
    log.step("completed message", {
      queueName: env("CLOUDRIFT_LIVE_AZURE_SERVICEBUS_QUEUE")!,
      marker,
    });
  });
});
