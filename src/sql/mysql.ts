/**
 * MySQL (and wire-compatible engines such as Amazon Aurora MySQL) backed by the
 * async `mysql2/promise` driver. Ports `cloudrift-py`'s `cloudrift/sql/mysql.py`.
 */
import { SQLAuthError, SQLConnectionError } from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { SQLBackend, type SqlConnection } from "./base.js";
import { buildSqlalchemyUrl, parseSqlUrl } from "./url.js";

const PROVIDER = "mysql";
const MYSQL_PACKAGE = "mysql2/promise";
const RDS_SIGNER_PACKAGE = "@aws-sdk/rds-signer";

/** Shape of the lazily-imported `mysql2/promise` module (just what we touch). */
interface MySqlModule {
  createConnection(config: Record<string, unknown>): Promise<MySqlConnection>;
}
interface MySqlConnection {
  end(): Promise<void>;
  close?: () => Promise<void>;
}

interface RdsSignerModule {
  Signer: new (config: { hostname: string; port: number; username: string; region?: string }) => {
    getAuthToken(): Promise<string>;
  };
}

export interface MySqlCredentialsOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  database?: string;
  connectKwargs?: Record<string, unknown>;
}

export interface MySqlUrlOptions {
  url: string;
  connectKwargs?: Record<string, unknown>;
}

export interface MySqlIamAuthOptions {
  host: string;
  port: number;
  user: string;
  database: string;
  region: string;
  connectKwargs?: Record<string, unknown>;
}

interface MySqlInit {
  host: string;
  port: number;
  user?: string;
  database?: string;
  password?: string;
  iam: boolean;
  region?: string;
  connectKwargs: Record<string, unknown>;
}

export class MySQLSQLBackend extends SQLBackend {
  override readonly dialect: string = "mysql";
  /** Default SQLAlchemy scheme for sqlalchemyUrl() — async aiomysql driver. */
  protected readonly saScheme: string = "mysql+aiomysql";

  protected readonly init: MySqlInit;

  protected constructor(init: MySqlInit) {
    super();
    this.init = init;
  }

  // ------------------------------------------------------------------
  // Factory constructors
  // ------------------------------------------------------------------

  /** Authenticate with a static username/password. */
  static fromCredentials(opts: MySqlCredentialsOptions): MySQLSQLBackend {
    return new MySQLSQLBackend({
      host: opts.host,
      port: Number(opts.port),
      user: opts.user,
      database: opts.database,
      password: opts.password,
      iam: false,
      connectKwargs: opts.connectKwargs ?? {},
    });
  }

  /** Authenticate from a connection URL (scheme is ignored). `database` optional. */
  static fromUrl(opts: MySqlUrlOptions): MySQLSQLBackend {
    const p = parseSqlUrl(opts.url, 3306);
    // Carry undefined through (don't coerce to "") so the driver falls back to
    // env/OS defaults, matching Python which forwards None.
    return MySQLSQLBackend.fromCredentials({
      host: p.host,
      port: p.port ?? 3306,
      user: p.user,
      password: p.password,
      database: p.database,
      connectKwargs: opts.connectKwargs,
    });
  }

  /**
   * Authenticate to AWS RDS/Aurora MySQL using an IAM auth token.
   *
   * A short-lived token is generated on every {@link connect} call and used as
   * the password. IAM auth requires TLS; configure `ssl` via `connectKwargs` as
   * your deployment requires.
   */
  static fromIamAuth(opts: MySqlIamAuthOptions): MySQLSQLBackend {
    return new MySQLSQLBackend({
      host: opts.host,
      port: Number(opts.port),
      user: opts.user,
      database: opts.database,
      iam: true,
      region: opts.region,
      connectKwargs: opts.connectKwargs ?? {},
    });
  }

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
    const mysql = await loadOptional<MySqlModule>(MYSQL_PACKAGE, PROVIDER);

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
      config.connectTimeout = Math.trunc(timeout) * 1000;
    }
    try {
      return await mysql.createConnection(config);
    } catch (err) {
      if (err instanceof SQLAuthError) {
        throw err;
      }
      throw new SQLConnectionError(
        `Failed to connect to MySQL at ${this.init.host}:${this.init.port}: ${errorMessage(err)}`,
        { cause: err },
      );
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
