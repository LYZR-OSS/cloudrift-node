/**
 * AWS DocumentDB connection factory.
 *
 * Returns a configured native `MongoClient` (from the `mongodb` driver). The
 * caller selects database and collection (`client.db(name).collection(name)`)
 * and uses the driver's native async API directly.
 *
 * Lifecycle is caller-managed: call `client.close()` at shutdown.
 */
import type { MongoClient, MongoClientOptions } from "mongodb";

import { CloudRiftError, DocumentConnectionError } from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";

/** Constructor signature for the native `mongodb` `MongoClient`. */
export type MongoClientConstructor = new (
  uri: string,
  options?: MongoClientOptions,
) => MongoClient;

/** Connection-pool sizing options shared by every connect helper. */
export interface PoolOptions {
  /** Max connection pool size (default 100). */
  maxPoolSize?: number;
  /** Min connection pool size (default 0). */
  minPoolSize?: number;
}

const DEFAULT_MAX_POOL_SIZE = 100;
const DEFAULT_MIN_POOL_SIZE = 0;

/**
 * Byte-for-byte equivalent of Python's `urllib.parse.quote_plus`, used by the
 * Python source of record to encode credentials into MongoDB URIs.
 *
 * `encodeURIComponent` differs from `quote_plus` for several characters that
 * are legal in Mongo credentials: it leaves `! * ' ( )` unescaped (quote_plus
 * percent-encodes them) and encodes a space as `%20` (quote_plus uses `+`).
 * A literal `+` in a URI userinfo is NOT decoded back to a space, so a password
 * containing a space would otherwise authenticate differently between the two
 * ports. This helper reproduces quote_plus exactly so the constructed URI
 * matches the Python output.
 */
export function quotePlus(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/**
 * Test seam: an injectable `MongoClient` constructor. When unset, the real
 * driver is loaded lazily via {@link loadOptional}. Tests set this to a
 * recording constructor to assert URI/option building without a live server.
 */
let clientCtorOverride: MongoClientConstructor | undefined;

/** Override the `MongoClient` constructor used by this module (testing only). */
export function setMongoClientConstructor(
  ctor: MongoClientConstructor | undefined,
): void {
  clientCtorOverride = ctor;
}

async function resolveCtor(): Promise<MongoClientConstructor> {
  if (clientCtorOverride) {
    return clientCtorOverride;
  }
  const mod = await loadOptional<{ MongoClient: MongoClientConstructor }>(
    "mongodb",
    "documentdb",
  );
  return mod.MongoClient;
}

function poolOptions(opts: PoolOptions): MongoClientOptions {
  return {
    maxPoolSize: opts.maxPoolSize ?? DEFAULT_MAX_POOL_SIZE,
    minPoolSize: opts.minPoolSize ?? DEFAULT_MIN_POOL_SIZE,
  };
}

async function construct(
  uri: string,
  options: MongoClientOptions,
): Promise<MongoClient> {
  // Resolve the constructor outside the try so a missing-package CloudRiftError
  // (the actionable "install mongodb ..." hint) propagates unchanged instead of
  // being re-wrapped as a DocumentConnectionError.
  const Ctor = await resolveCtor();
  try {
    return new Ctor(uri, options);
  } catch (err) {
    if (err instanceof CloudRiftError) {
      throw err;
    }
    throw new DocumentConnectionError(
      `Failed to connect to DocumentDB: ${String(err)}`,
      { cause: err },
    );
  }
}

/** Connect using a full MongoDB-compatible URI. */
export async function connectUri(
  opts: { uri: string; tlsCaFile?: string } & PoolOptions &
    Record<string, unknown>,
): Promise<MongoClient> {
  const { uri, tlsCaFile, maxPoolSize, minPoolSize, ...rest } = opts;
  const options: MongoClientOptions = {
    ...poolOptions({ maxPoolSize, minPoolSize }),
  };
  if (tlsCaFile) {
    options.tlsCAFile = tlsCaFile;
  }
  // Passthrough of any extra client options (mirrors Python **client_kwargs).
  Object.assign(options, rest as MongoClientOptions);
  return construct(uri, options);
}

/** Connect using explicit host, port, username, and password. */
export async function connectCredentials(
  opts: {
    host: string;
    port: number;
    username: string;
    password: string;
    tls?: boolean;
    tlsCaFile?: string;
  } & PoolOptions,
): Promise<MongoClient> {
  const { host, port, username, password, tls = true, tlsCaFile } = opts;
  const uri = `mongodb://${quotePlus(username)}:${quotePlus(
    password,
  )}@${host}:${port}/`;
  const options: MongoClientOptions = {
    tls,
    ...poolOptions(opts),
  };
  if (tlsCaFile) {
    options.tlsCAFile = tlsCaFile;
  }
  return construct(uri, options);
}

/** Connect using mutual TLS (mTLS) with a client certificate. */
export async function connectTlsCert(
  opts: {
    host: string;
    port: number;
    username: string;
    password: string;
    tlsCertKeyFile: string;
    tlsCaFile?: string;
  } & PoolOptions,
): Promise<MongoClient> {
  const { host, port, username, password, tlsCertKeyFile, tlsCaFile } = opts;
  const uri = `mongodb://${quotePlus(username)}:${quotePlus(
    password,
  )}@${host}:${port}/`;
  const options: MongoClientOptions = {
    tls: true,
    tlsCertificateKeyFile: tlsCertKeyFile,
    ...poolOptions(opts),
  };
  if (tlsCaFile) {
    options.tlsCAFile = tlsCaFile;
  }
  return construct(uri, options);
}
