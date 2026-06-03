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
import { env, requireEnv, uniqueName } from "./env.js";

/* ================================================================== */
/* Blob                                                               */
/* ================================================================== */

const BLOB_PRESENT = requireEnv(["CLOUDRIFT_LIVE_AZURE_STORAGE_CONNECTION_STRING"]);

describe.skipIf(!BLOB_PRESENT)("Azure Blob live lifecycle", () => {
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
    } else {
      container = uniqueName("container");
      await service.getContainerClient(container).create();
      createdContainer = true;
    }
    backend = await getStorage("azure_blob", { connectionString, container });
  });

  afterAll(async () => {
    try {
      await backend?.close();
    } catch (err) {
      console.warn("[live blob] backend close failed:", err);
    }
    try {
      if (createdContainer) {
        const service = BlobServiceClient.fromConnectionString(connectionString);
        await service.getContainerClient(container).delete();
      }
    } catch (err) {
      console.warn("[live blob] cleanup failed:", err);
    }
  });

  it("uploads, reads back, and deletes a blob", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    await b.upload(key, payload, "text/plain");
    const downloaded = await b.download(key);
    expect(downloaded.equals(payload)).toBe(true);

    await b.delete(key);
    expect(await b.exists(key)).toBe(false);
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
  const name = uniqueName("kv-secret");
  let backend: Awaited<ReturnType<typeof getSecrets>> | undefined;

  beforeAll(async () => {
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
    } catch (err) {
      console.warn("[live keyvault] cleanup failed:", err);
    }
    try {
      await backend?.close();
    } catch (err) {
      console.warn("[live keyvault] backend close failed:", err);
    }
  });

  it("sets and reads back a secret", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    const value = "cloudrift-live-kv-value";
    await b.setSecret(name, value);
    expect(await b.getSecret(name)).toBe(value);
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
  let backend: Awaited<ReturnType<typeof getPubsub>> | undefined;

  beforeAll(async () => {
    backend = await getPubsub("azure_eventgrid", {
      endpoint: env("CLOUDRIFT_LIVE_AZURE_EVENTGRID_ENDPOINT")!,
      accessKey: env("CLOUDRIFT_LIVE_AZURE_EVENTGRID_KEY")!,
    });
  });

  afterAll(async () => {
    try {
      await backend?.close();
    } catch (err) {
      console.warn("[live eventgrid] backend close failed:", err);
    }
  });

  it("publishes a single event without throwing and returns an id", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    const id = await b.publish("cloudrift/live", "cloudrift-live-eventgrid");
    expect(id).toBeTruthy();
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
  let backend: Awaited<ReturnType<typeof getQueue>> | undefined;

  beforeAll(async () => {
    backend = await getQueue("azure_service_bus", {
      connectionString: env("CLOUDRIFT_LIVE_AZURE_SERVICEBUS_CONNECTION_STRING")!,
      queueName: env("CLOUDRIFT_LIVE_AZURE_SERVICEBUS_QUEUE")!,
    });
  });

  afterAll(async () => {
    try {
      await backend?.close();
    } catch (err) {
      console.warn("[live servicebus] backend close failed:", err);
    }
  });

  it("sends, receives (bounded wait), and completes a message", async () => {
    expect(backend).toBeDefined();
    const b = backend!;

    const marker = uniqueName("sb-msg");
    await b.send({ marker });

    // Bounded wait via the API's own maxWaitTimeInMs (waitTime seconds here).
    const received = await b.receive(1, 20);
    expect(received.length).toBeGreaterThanOrEqual(1);
    const msg = received[0];
    expect(msg.body).toEqual({ marker });

    await b.delete(msg.receiptHandle);
  });
});
