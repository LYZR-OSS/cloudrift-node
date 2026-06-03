/**
 * Document database connection factory.
 *
 * Returns a configured native `MongoClient` regardless of provider — both AWS
 * DocumentDB and Azure Cosmos DB (MongoDB API) speak the MongoDB wire protocol,
 * so the caller uses the driver's native async API directly.
 *
 *     import { getMongodb } from "@lyzr/cloudrift";
 *
 *     const client = await getMongodb("documentdb", { uri: "mongodb://..." });
 *     await client.db("mydb").collection("users").insertOne({ name: "Alice" });
 *     await client.close();
 */
import type { MongoClient } from "mongodb";

import { CloudRiftError } from "../core/errors.js";
import { connectCredentials, connectTlsCert, connectUri } from "./documentdb.js";
import { connectAccountKey, connectConnectionString } from "./cosmos.js";

export type DocumentProvider = "documentdb" | "cosmos";

export {
  connectCredentials,
  connectTlsCert,
  connectUri,
  setMongoClientConstructor as setDocumentDbClientConstructor,
} from "./documentdb.js";
export type { MongoClientConstructor, PoolOptions } from "./documentdb.js";
export {
  connectAccountKey,
  connectConnectionString,
  setMongoClientConstructor as setCosmosClientConstructor,
} from "./cosmos.js";

function has(options: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(options, key);
}

/**
 * Build an async MongoDB client for the given provider.
 *
 * Routes to the appropriate `connect*` helper based on which option keys are
 * present, mirroring the Python factory dispatch.
 *
 * @param provider `"documentdb"` or `"cosmos"`.
 * @param options  Provider-specific config.
 */
export async function getMongodb(
  provider: DocumentProvider,
  options: Record<string, unknown>,
): Promise<MongoClient> {
  if (provider === "documentdb") {
    if (has(options, "uri")) {
      return connectUri(options as Parameters<typeof connectUri>[0]);
    }
    if (has(options, "tlsCertKeyFile")) {
      return connectTlsCert(options as unknown as Parameters<typeof connectTlsCert>[0]);
    }
    return connectCredentials(options as unknown as Parameters<typeof connectCredentials>[0]);
  }

  if (provider === "cosmos") {
    if (has(options, "connectionString")) {
      return connectConnectionString(
        options as unknown as Parameters<typeof connectConnectionString>[0],
      );
    }
    return connectAccountKey(options as unknown as Parameters<typeof connectAccountKey>[0]);
  }

  throw new CloudRiftError(
    `Unknown document DB provider: ${String(provider)}. Choose 'documentdb' or 'cosmos'.`,
  );
}
