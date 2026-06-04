/**
 * Document DB live lifecycle test (MongoDB wire protocol: DocumentDB / Cosmos).
 *
 * Gated on CLOUDRIFT_LIVE_TESTS=1 + CLOUDRIFT_LIVE_MONGO_URI. The provider is
 * selected by CLOUDRIFT_LIVE_MONGO_PROVIDER (default "documentdb"). We use a
 * uniquely-named collection in db "cloudrift_live_test", drop it, and close the
 * client. Cleanup is wrapped so it never masks a test failure.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getMongodb } from "../../src/index.js";
import { env, liveLog, requireEnv, uniqueName } from "./env.js";

const MONGO_PRESENT = requireEnv(["CLOUDRIFT_LIVE_MONGO_URI"]);

const DB_NAME = "cloudrift_live_test";

describe.skipIf(!MONGO_PRESENT)("MongoDB live lifecycle", () => {
  const log = liveLog("mongo");
  const provider = env("CLOUDRIFT_LIVE_MONGO_PROVIDER") ?? "documentdb";
  const collectionName = uniqueName("coll").replace(/-/g, "_");
  let client: Awaited<ReturnType<typeof getMongodb>> | undefined;

  beforeAll(async () => {
    const uri = env("CLOUDRIFT_LIVE_MONGO_URI")!;
    const options = provider === "cosmos" ? { connectionString: uri } : { uri };
    log.step("initializing client", { provider, database: DB_NAME, collectionName });
    client = await getMongodb(provider, options);
  });

  afterAll(async () => {
    try {
      await client?.db(DB_NAME).collection(collectionName).drop();
      log.step("dropped collection", { database: DB_NAME, collectionName });
    } catch (err) {
      log.warn("cleanup failed", err, { database: DB_NAME, collectionName });
    }
    try {
      await client?.close();
      log.step("closed client", { provider });
    } catch (err) {
      log.warn("client close failed", err, { provider });
    }
  });

  it("inserts and reads back a document", async () => {
    expect(client).toBeDefined();
    const collection = client!.db(DB_NAME).collection(collectionName);

    const marker = uniqueName("doc");
    log.step("inserting document", { database: DB_NAME, collectionName, marker });
    await collection.insertOne({ marker, n: 7 });

    const found = await collection.findOne({ marker });
    expect(found).not.toBeNull();
    expect(found.marker).toBe(marker);
    expect(found.n).toBe(7);
    log.step("read document", { database: DB_NAME, collectionName, marker });
  });
});
