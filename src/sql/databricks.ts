/**
 * Databricks SQL warehouse backed by the `@databricks/sql` driver. Ports
 * `cloudrift-py`'s `cloudrift/sql/databricks.py`.
 *
 * The Python driver is synchronous and offloads `connect()` to a worker thread;
 * the Node `@databricks/sql` client is natively async (parity preserved at the
 * behavior level — `connect()` returns an open session).
 */
import { SQLConnectionError } from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { SQLBackend, type SqlConnection } from "./base.js";

const PROVIDER = "databricks";
const DATABRICKS_PACKAGE = "@databricks/sql";

/** Shape of the lazily-imported `@databricks/sql` module (just what we touch). */
interface DatabricksModule {
  DBSQLClient: new () => DatabricksClient;
}
interface DatabricksClient {
  connect(options: Record<string, unknown>): Promise<DatabricksClient>;
  openSession(options?: Record<string, unknown>): Promise<DatabricksSession>;
}
interface DatabricksSession {
  close(): Promise<void>;
}

export interface DatabricksTokenOptions {
  host: string;
  httpPath: string;
  token: string;
  port?: number;
  catalog?: string;
  schema?: string;
  connectionKwargs?: Record<string, unknown>;
}

interface DatabricksInit {
  host: string;
  httpPath: string;
  token: string;
  port: number;
  catalog?: string;
  schema?: string;
  connectionKwargs: Record<string, unknown>;
}

export class DatabricksSQLBackend extends SQLBackend {
  override readonly dialect: string = "databricks";

  private readonly init: DatabricksInit;

  private constructor(init: DatabricksInit) {
    super();
    this.init = init;
  }

  /** Authenticate with an access token (PAT or OAuth). */
  static fromToken(opts: DatabricksTokenOptions): DatabricksSQLBackend {
    return new DatabricksSQLBackend({
      host: opts.host,
      httpPath: opts.httpPath,
      token: opts.token,
      port: opts.port ?? 443,
      catalog: opts.catalog,
      schema: opts.schema,
      connectionKwargs: opts.connectionKwargs ?? {},
    });
  }

  override async connect(timeout?: number): Promise<SqlConnection> {
    const databricks = await loadOptional<DatabricksModule>(DATABRICKS_PACKAGE, PROVIDER);

    const host = this.init.port === 443 ? this.init.host : `${this.init.host}:${this.init.port}`;
    const connectOptions: Record<string, unknown> = {
      host,
      path: this.init.httpPath,
      token: this.init.token,
      ...this.init.connectionKwargs,
    };

    const sessionOptions: Record<string, unknown> = {};
    if (this.init.catalog !== undefined) {
      sessionOptions.initialCatalog = this.init.catalog;
    }
    if (this.init.schema !== undefined) {
      sessionOptions.initialSchema = this.init.schema;
    }

    const open = async (): Promise<SqlConnection> => {
      const client = new databricks.DBSQLClient();
      await client.connect(connectOptions);
      return client.openSession(
        Object.keys(sessionOptions).length > 0 ? sessionOptions : undefined,
      );
    };

    try {
      if (timeout !== undefined) {
        return await withTimeout(open(), timeout);
      }
      return await open();
    } catch (err) {
      if (err instanceof SQLConnectionError) {
        throw err;
      }
      throw new SQLConnectionError(`Failed to connect to Databricks: ${errorMessage(err)}`, {
        cause: err,
      });
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutSeconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new SQLConnectionError(
          `Timed out connecting to Databricks after ${timeoutSeconds} seconds.`,
        ),
      );
    }, timeoutSeconds * 1000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
