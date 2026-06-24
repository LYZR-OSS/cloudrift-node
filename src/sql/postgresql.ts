/**
 * PostgreSQL (and wire-compatible engines such as Amazon Redshift) backed by the
 * `pg` driver. Ports `cloudrift-py`'s `cloudrift/sql/postgresql.py`.
 */
import { SQLAuthError, SQLConnectionError } from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { SQLBackend, type SqlConnection } from "./base.js";
import { buildSqlalchemyUrl, parseSqlUrl } from "./url.js";

const PROVIDER = "postgres";
const PG_PACKAGE = "pg";
const RDS_SIGNER_PACKAGE = "@aws-sdk/rds-signer";

/** Shape of the lazily-imported `pg` module (just what we touch). */
interface PgModule {
  Client: new (config: Record<string, unknown>) => PgClient;
  Pool: new (config: Record<string, unknown>) => PgPool;
}
interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  close?: () => Promise<void>;
}
/** Minimal shape of a `pg.Pool` and the client it leases. */
interface PgPool {
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}
interface PgPoolClient {
  release(): void;
}

/** Shape of the lazily-imported `@aws-sdk/rds-signer` module. */
interface RdsSignerModule {
  Signer: new (config: { hostname: string; port: number; username: string; region?: string }) => {
    getAuthToken(): Promise<string>;
  };
}

export interface PostgresCredentialsOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  database?: string;
  pool?: boolean;
  poolMinSize?: number;
  poolMaxSize?: number;
  connectKwargs?: Record<string, unknown>;
}

export interface PostgresUrlOptions {
  url: string;
  connectKwargs?: Record<string, unknown>;
}

export interface PostgresIamAuthOptions {
  host: string;
  port: number;
  user: string;
  database: string;
  region: string;
  connectKwargs?: Record<string, unknown>;
}

interface PostgresInit {
  host: string;
  port: number;
  user?: string;
  database?: string;
  password?: string;
  iam: boolean;
  region?: string;
  connectKwargs: Record<string, unknown>;
  pool: boolean;
  poolMinSize: number;
  poolMaxSize: number;
}

export class PostgresSQLBackend extends SQLBackend {
  override readonly dialect: string = "postgresql";
  /** Default SQLAlchemy scheme for sqlalchemyUrl() — async psycopg v3 driver. */
  protected readonly saScheme: string = "postgresql+psycopg";

  protected readonly init: PostgresInit;
  private pgPool: PgPool | undefined;

  protected constructor(init: PostgresInit) {
    super();
    this.init = init;
  }

  // ------------------------------------------------------------------
  // Factory constructors
  // ------------------------------------------------------------------

  /**
   * Authenticate with a static username/password.
   *
   * Set `pool: true` to enable a `pg.Pool` connection pool used by
   * {@link withConnection}; `connect()` still opens standalone connections.
   */
  static fromCredentials(opts: PostgresCredentialsOptions): PostgresSQLBackend {
    return new this({
      host: opts.host,
      port: Number(opts.port),
      user: opts.user,
      database: opts.database,
      password: opts.password,
      iam: false,
      connectKwargs: opts.connectKwargs ?? {},
      pool: opts.pool ?? false,
      poolMinSize: opts.poolMinSize ?? 0,
      poolMaxSize: opts.poolMaxSize ?? 10,
    });
  }

  /** Authenticate from a connection URL (scheme is ignored). */
  static fromUrl(opts: PostgresUrlOptions): PostgresSQLBackend {
    const p = parseSqlUrl(opts.url, 5432);
    // Carry undefined through (don't coerce to "") so the driver falls back to
    // env/OS defaults, matching Python which forwards None.
    return this.fromCredentials({
      host: p.host,
      port: p.port ?? 5432,
      user: p.user,
      password: p.password,
      database: p.database,
      connectKwargs: opts.connectKwargs,
    });
  }

  /**
   * Authenticate to AWS RDS/Aurora PostgreSQL using an IAM auth token.
   *
   * A short-lived (15 min) token is generated on every {@link connect} call and
   * used in place of a password. IAM auth requires TLS, so `ssl` defaults to
   * `{ rejectUnauthorized: false }` unless overridden in `connectKwargs`.
   */
  static fromIamAuth(opts: PostgresIamAuthOptions): PostgresSQLBackend {
    const connectKwargs = { ...(opts.connectKwargs ?? {}) };
    if (!("ssl" in connectKwargs)) {
      connectKwargs.ssl = { rejectUnauthorized: false };
    }
    return new this({
      host: opts.host,
      port: Number(opts.port),
      user: opts.user,
      database: opts.database,
      iam: true,
      region: opts.region,
      connectKwargs,
      pool: false,
      poolMinSize: 0,
      poolMaxSize: 10,
    });
  }

  /**
   * Return a SQLAlchemy-style URL for this connection (for SQLAlchemy-based
   * consumers). `driver` overrides the dialect+driver scheme. Not available for
   * IAM auth, whose token cannot be embedded in a static URL.
   */
  sqlalchemyUrl(driver?: string): string {
    if (this.init.iam) {
      throw new SQLAuthError("sqlalchemyUrl() is unavailable for IAM auth (token is dynamic).");
    }
    return buildSqlalchemyUrl(driver ?? this.saScheme, {
      host: this.init.host,
      port: this.init.port,
      user: this.init.user,
      password: this.init.password,
      database: this.init.database,
    });
  }

  // ------------------------------------------------------------------
  // Connection
  // ------------------------------------------------------------------

  protected async rdsToken(): Promise<string> {
    const signerMod = await loadOptional<RdsSignerModule>(RDS_SIGNER_PACKAGE, PROVIDER);
    try {
      const signer = new signerMod.Signer({
        hostname: this.init.host,
        port: this.init.port,
        // IAM auth always supplies a user (see fromIamAuth).
        username: this.init.user ?? "",
        region: this.init.region,
      });
      return await signer.getAuthToken();
    } catch (err) {
      throw new SQLAuthError(`Failed to generate RDS IAM auth token: ${errorMessage(err)}`, {
        cause: err,
      });
    }
  }

  override async connect(timeout?: number): Promise<SqlConnection> {
    const pg = await loadOptional<PgModule>(PG_PACKAGE, PROVIDER);

    const password = this.init.iam ? await this.rdsToken() : this.init.password;
    const config: Record<string, unknown> = {
      host: this.init.host,
      port: this.init.port,
      user: this.init.user,
      password,
      database: this.init.database,
      ...this.init.connectKwargs,
    };
    if (timeout !== undefined) {
      config.connectionTimeoutMillis = Math.trunc(timeout) * 1000;
    }
    try {
      const client = new pg.Client(config);
      await client.connect();
      return client;
    } catch (err) {
      if (err instanceof SQLAuthError) {
        throw err;
      }
      throw new SQLConnectionError(
        `Failed to connect to PostgreSQL at ${this.init.host}:${this.init.port}: ${errorMessage(err)}`,
        { cause: err },
      );
    }
  }

  // ------------------------------------------------------------------
  // Pooling (opt-in via pool=true)
  // ------------------------------------------------------------------

  /**
   * Lease a connection. When pooling is enabled a `pg.Pool` client is leased and
   * released back to the pool; otherwise a fresh standalone connection is opened
   * and closed. Mirrors Python's `acquire`/`_ensure_pool`. IAM auth uses a static
   * password unsuitable for a long-lived pool, so it falls back to standalone.
   */
  override async withConnection<T>(
    cb: (conn: SqlConnection) => Promise<T>,
    timeout?: number,
  ): Promise<T> {
    if (!this.init.pool || this.init.iam) {
      return super.withConnection(cb, timeout);
    }
    const pool = await this.ensurePool();
    const client = await pool.connect();
    try {
      return await cb(client);
    } finally {
      client.release();
    }
  }

  private async ensurePool(): Promise<PgPool> {
    if (this.pgPool === undefined) {
      const pg = await loadOptional<PgModule>(PG_PACKAGE, PROVIDER);
      const config: Record<string, unknown> = {
        host: this.init.host,
        port: this.init.port,
        user: this.init.user,
        password: this.init.password,
        database: this.init.database,
        min: this.init.poolMinSize,
        max: this.init.poolMaxSize,
        ...this.init.connectKwargs,
      };
      this.pgPool = new pg.Pool(config);
    }
    return this.pgPool;
  }

  /** Release the pool (if any). Does not close standalone connections. */
  override async close(): Promise<void> {
    const pool = this.pgPool;
    if (pool !== undefined) {
      this.pgPool = undefined;
      await pool.end();
    }
  }
}

/**
 * Amazon Redshift backend. Redshift speaks the PostgreSQL wire protocol, so this
 * reuses {@link PostgresSQLBackend} and only differs in `dialect` and a UTF-8
 * client-encoding default.
 */
export class RedshiftSQLBackend extends PostgresSQLBackend {
  override readonly dialect: string = "redshift";

  static override fromCredentials(opts: PostgresCredentialsOptions): RedshiftSQLBackend {
    const connectKwargs = { ...(opts.connectKwargs ?? {}) };
    if (!("client_encoding" in connectKwargs)) {
      connectKwargs.client_encoding = "utf8";
    }
    return super.fromCredentials({ ...opts, connectKwargs }) as RedshiftSQLBackend;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
