/**
 * Azure Cosmos DB (MongoDB API) connection factory.
 *
 * Cosmos DB exposes a MongoDB wire-protocol endpoint. We connect with the
 * native `mongodb` driver and return a `MongoClient`, identical in shape to
 * the DocumentDB helpers.
 *
 * Only key-based auth is supported here: Cosmos for MongoDB (RU) does not accept
 * Azure AD tokens at the Mongo wire-protocol layer. Use a connection string from
 * the portal or build one from the account name + key.
 *
 * Lifecycle is caller-managed: call `client.close()` at shutdown.
 */
import { CloudRiftError, DocumentConnectionError } from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import {
  quotePlus,
  type MongoClientConstructor,
  type MongoClientLike,
  type MongoClientOptionsLike,
  type PoolOptions,
} from "./documentdb.js";

const DEFAULT_MAX_POOL_SIZE = 100;
const DEFAULT_MIN_POOL_SIZE = 0;
const DEFAULT_PORT = 10255;

/**
 * Test seam: an injectable `MongoClient` constructor. When unset, the real
 * driver is loaded lazily via {@link loadOptional}.
 */
let clientCtorOverride: MongoClientConstructor | undefined;

/** Override the `MongoClient` constructor used by this module (testing only). */
export function setMongoClientConstructor(ctor: MongoClientConstructor | undefined): void {
  clientCtorOverride = ctor;
}

async function resolveCtor(): Promise<MongoClientConstructor> {
  if (clientCtorOverride) {
    return clientCtorOverride;
  }
  const mod = await loadOptional<{ MongoClient: MongoClientConstructor }>("mongodb", "cosmos");
  return mod.MongoClient;
}

function poolOptions(opts: PoolOptions): MongoClientOptionsLike {
  return {
    maxPoolSize: opts.maxPoolSize ?? DEFAULT_MAX_POOL_SIZE,
    minPoolSize: opts.minPoolSize ?? DEFAULT_MIN_POOL_SIZE,
  };
}

async function construct(uri: string, options: MongoClientOptionsLike): Promise<MongoClientLike> {
  // Resolve the constructor outside the try so a missing-package CloudRiftError
  // (the actionable "install mongodb ..." hint) propagates unchanged.
  const Ctor = await resolveCtor();
  try {
    return new Ctor(uri, options);
  } catch (err) {
    if (err instanceof CloudRiftError) {
      throw err;
    }
    throw new DocumentConnectionError(`Failed to connect to Cosmos DB: ${String(err)}`, {
      cause: err,
    });
  }
}

/** Connect using a Cosmos MongoDB-API connection string from the Azure portal. */
export async function connectConnectionString(
  opts: { connectionString: string } & PoolOptions,
): Promise<MongoClientLike> {
  const { connectionString } = opts;
  return construct(connectionString, poolOptions(opts));
}

/** Build a Cosmos MongoDB-API URI from the account name and key. */
export async function connectAccountKey(
  opts: {
    account: string;
    accountKey: string;
    port?: number;
    appName?: string;
  } & PoolOptions,
): Promise<MongoClientLike> {
  const { account, accountKey, port = DEFAULT_PORT, appName } = opts;
  const user = quotePlus(account);
  const pwd = quotePlus(accountKey);
  const host = `${account}.mongo.cosmos.azure.com`;
  const app = appName !== undefined ? appName : `@${account}@`;
  const query =
    "ssl=true" +
    "&replicaSet=globaldb" +
    "&retryWrites=false" +
    "&maxIdleTimeMS=120000" +
    `&appName=${quotePlus(app)}`;
  const uri = `mongodb://${user}:${pwd}@${host}:${port}/?${query}`;
  return construct(uri, poolOptions(opts));
}
