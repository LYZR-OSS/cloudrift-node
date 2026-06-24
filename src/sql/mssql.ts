/**
 * Microsoft SQL Server / Azure SQL Database backed by the async `mssql`
 * (tedious) driver. Ports `cloudrift-py`'s `cloudrift/sql/mssql.py`.
 *
 * The Python port uses ODBC and passes Entra/AAD tokens via the
 * `SQL_COPT_SS_ACCESS_TOKEN` pre-connect attribute. The npm `mssql` driver
 * instead accepts the AAD token directly through its `authentication` config
 * (`azure-active-directory-access-token`), so a fresh token is still minted per
 * `connect()` call — see docs/PARITY.md.
 */
import { SQLAuthError, SQLConnectionError } from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { SQLBackend, type SqlConnection } from "./base.js";

const PROVIDER = "mssql";
const MSSQL_PACKAGE = "mssql";

const AAD_TOKEN_SCOPE = "https://database.windows.net/.default";

/** Shape of the lazily-imported `mssql` module (just what we touch). */
interface MssqlModule {
  ConnectionPool: new (config: Record<string, unknown>) => MssqlConnectionPool;
}
interface MssqlConnectionPool {
  connect(): Promise<MssqlConnectionPool>;
  close(): Promise<void>;
}

/** Callable that returns a fresh AAD access token string. */
export type TokenProvider = () => Promise<string>;

export interface MssqlCredentialsOptions {
  server: string;
  database: string;
  username: string;
  password: string;
  port?: number;
  serverCertificate?: string;
  connectionKwargs?: Record<string, unknown>;
  pool?: boolean;
  poolMinSize?: number;
  poolMaxSize?: number;
}

export interface MssqlServicePrincipalOptions {
  server: string;
  database: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  port?: number;
  connectionKwargs?: Record<string, unknown>;
}

export interface MssqlManagedIdentityOptions {
  server: string;
  database: string;
  clientId?: string;
  port?: number;
  connectionKwargs?: Record<string, unknown>;
}

interface MssqlInit {
  server: string;
  database: string;
  port?: number;
  username?: string;
  password?: string;
  serverCertificate?: string;
  tokenProvider?: TokenProvider;
  connectionKwargs: Record<string, unknown>;
  pool: boolean;
  poolMinSize: number;
  poolMaxSize: number;
}

export class MSSQLSQLBackend extends SQLBackend {
  override readonly dialect: string = "mssql";

  private readonly init: MssqlInit;
  private pool: MssqlConnectionPool | undefined;

  private constructor(init: MssqlInit) {
    super();
    this.init = init;
  }

  // ------------------------------------------------------------------
  // Factory constructors
  // ------------------------------------------------------------------

  /**
   * Authenticate with a SQL login (username/password). `pool=true` enables a
   * shared connection pool used by {@link withConnection} (credential auth
   * only — token auth cannot share a static pool); `connect()` still opens
   * standalone connections.
   */
  static fromCredentials(opts: MssqlCredentialsOptions): MSSQLSQLBackend {
    return new MSSQLSQLBackend({
      server: opts.server,
      database: opts.database,
      port: opts.port,
      username: opts.username,
      password: opts.password,
      serverCertificate: opts.serverCertificate,
      connectionKwargs: opts.connectionKwargs ?? {},
      pool: opts.pool ?? false,
      poolMinSize: opts.poolMinSize ?? 1,
      poolMaxSize: opts.poolMaxSize ?? 10,
    });
  }

  /** Authenticate via an Azure AD / Entra service principal. */
  static fromEntraServicePrincipal(opts: MssqlServicePrincipalOptions): MSSQLSQLBackend {
    const provider: TokenProvider = async () => {
      const identity = await loadOptional<typeof import("@azure/identity")>(
        "@azure/identity",
        PROVIDER,
      );
      const cred = new identity.ClientSecretCredential(
        opts.tenantId,
        opts.clientId,
        opts.clientSecret,
      );
      const token = await cred.getToken(AAD_TOKEN_SCOPE);
      return token.token;
    };
    return new MSSQLSQLBackend({
      server: opts.server,
      database: opts.database,
      port: opts.port,
      tokenProvider: provider,
      connectionKwargs: opts.connectionKwargs ?? {},
      pool: false,
      poolMinSize: 1,
      poolMaxSize: 10,
    });
  }

  /** Authenticate via an Azure managed identity (system- or user-assigned). */
  static fromEntraManagedIdentity(opts: MssqlManagedIdentityOptions): MSSQLSQLBackend {
    const provider: TokenProvider = async () => {
      const identity = await loadOptional<typeof import("@azure/identity")>(
        "@azure/identity",
        PROVIDER,
      );
      const cred =
        opts.clientId !== undefined
          ? new identity.ManagedIdentityCredential(opts.clientId)
          : new identity.ManagedIdentityCredential();
      const token = await cred.getToken(AAD_TOKEN_SCOPE);
      return token.token;
    };
    return new MSSQLSQLBackend({
      server: opts.server,
      database: opts.database,
      port: opts.port,
      tokenProvider: provider,
      connectionKwargs: opts.connectionKwargs ?? {},
      pool: false,
      poolMinSize: 1,
      poolMaxSize: 10,
    });
  }

  // ------------------------------------------------------------------
  // Config assembly
  // ------------------------------------------------------------------

  /**
   * Assemble the `mssql` driver config. Credentials are included only for SQL-
   * login auth; token auth supplies an `authentication` block carrying a fresh
   * AAD access token instead of UID/PWD.
   */
  async buildConfig(timeout?: number): Promise<Record<string, unknown>> {
    // Pull `connectionTimeout` out of the kwargs so it acts only as a fallback
    // default, never overriding an explicit `timeout` arg (Python pops
    // "Connection Timeout" then prefers the explicit arg).
    const {
      options: extraOptions,
      connectionTimeout: kwargsTimeout,
      ...rest
    } = this.init.connectionKwargs as {
      options?: Record<string, unknown>;
      connectionTimeout?: number;
    } & Record<string, unknown>;

    const options: Record<string, unknown> = {
      encrypt: true,
      trustServerCertificate: false,
      ...(extraOptions ?? {}),
    };

    // Explicit timeout arg wins; else fall back to kwargs connectionTimeout;
    // else the 30s default. Mirrors Python's `_timeout_default` handling.
    const connectionTimeout =
      timeout !== undefined ? Math.trunc(timeout) * 1000 : (kwargsTimeout ?? 30_000);

    const config: Record<string, unknown> = {
      server: this.init.server,
      database: this.init.database,
      options,
      ...rest,
      // After the ...rest spread so the resolved timeout wins over any stray key.
      connectionTimeout,
    };
    if (this.init.port !== undefined) {
      config.port = this.init.port;
    }

    if (this.init.tokenProvider !== undefined) {
      let token: string;
      try {
        token = await this.init.tokenProvider();
      } catch (err) {
        throw new SQLAuthError(`Failed to acquire Azure AD access token: ${errorMessage(err)}`, {
          cause: err,
        });
      }
      config.authentication = {
        type: "azure-active-directory-access-token",
        options: { token },
      };
    } else {
      config.user = this.init.username;
      config.password = this.init.password;
    }
    return config;
  }

  // ------------------------------------------------------------------
  // Connection
  // ------------------------------------------------------------------

  override async connect(timeout?: number): Promise<SqlConnection> {
    const mssql = await loadOptional<MssqlModule>(MSSQL_PACKAGE, PROVIDER);

    if (this.init.serverCertificate !== undefined) {
      const { validatePinnedCertificate } = await import("./mssqlTls.js");
      await validatePinnedCertificate(
        this.init.server,
        this.init.port ?? 1433,
        this.init.serverCertificate,
      );
    }

    const config = await this.buildConfig(timeout);
    try {
      const pool = new mssql.ConnectionPool(config);
      return await pool.connect();
    } catch (err) {
      if (err instanceof SQLAuthError) {
        throw err;
      }
      throw new SQLConnectionError(
        `Failed to connect to MS SQL / Azure SQL at ${this.init.server}: ${errorMessage(err)}`,
        { cause: err },
      );
    }
  }

  // ------------------------------------------------------------------
  // Pooling (opt-in via pool=true; credential auth only)
  // ------------------------------------------------------------------

  override async withConnection<T>(
    cb: (conn: SqlConnection) => Promise<T>,
    timeout?: number,
  ): Promise<T> {
    if (!this.init.pool) {
      return super.withConnection(cb, timeout);
    }
    const pool = await this.ensurePool(timeout);
    return cb(pool);
  }

  private async ensurePool(timeout?: number): Promise<MssqlConnectionPool> {
    if (this.pool === undefined) {
      if (this.init.tokenProvider !== undefined) {
        throw new SQLConnectionError(
          "Connection pooling is not supported with Azure AD/Entra token auth (tokens " +
            "expire and cannot be shared across a static pool). Use connect() per query instead.",
        );
      }
      const mssql = await loadOptional<MssqlModule>(MSSQL_PACKAGE, PROVIDER);
      if (this.init.serverCertificate !== undefined) {
        const { validatePinnedCertificate } = await import("./mssqlTls.js");
        await validatePinnedCertificate(
          this.init.server,
          this.init.port ?? 1433,
          this.init.serverCertificate,
        );
      }
      const config = await this.buildConfig(timeout);
      config.pool = { min: this.init.poolMinSize, max: this.init.poolMaxSize };
      const pool = new mssql.ConnectionPool(config);
      this.pool = await pool.connect();
    }
    return this.pool;
  }

  override async close(): Promise<void> {
    const pool = this.pool;
    if (pool !== undefined) {
      this.pool = undefined;
      await pool.close();
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
