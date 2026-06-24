import { afterEach, describe, expect, it, vi } from "vitest";

import { getSql } from "../src/sql/index.js";
import { parseSqlUrl, buildSqlalchemyUrl } from "../src/sql/url.js";
import { PostgresSQLBackend, RedshiftSQLBackend } from "../src/sql/postgresql.js";
import { MySQLSQLBackend } from "../src/sql/mysql.js";
import { MSSQLSQLBackend } from "../src/sql/mssql.js";
import { OracleSQLBackend } from "../src/sql/oracle.js";
import { DatabricksSQLBackend } from "../src/sql/databricks.js";
import { validatePinnedCertificate } from "../src/sql/mssqlTls.js";
import { CloudRiftError, SQLAuthError, SQLConnectionError } from "../src/core/errors.js";

/* ------------------------------------------------------------------ */
/* Driver mocks (virtual — none of these packages are installed)       */
/* ------------------------------------------------------------------ */

const pgHarness = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
  connectError: undefined as unknown,
  poolConfigs: [] as Record<string, unknown>[],
  poolLeases: 0,
  poolReleases: 0,
  poolEnded: false,
}));

vi.mock("pg", () => {
  class Client {
    constructor(public config: Record<string, unknown>) {
      pgHarness.configs.push(config);
    }
    async connect(): Promise<void> {
      if (pgHarness.connectError !== undefined) {
        throw pgHarness.connectError;
      }
    }
    async end(): Promise<void> {}
  }
  class Pool {
    constructor(public config: Record<string, unknown>) {
      pgHarness.poolConfigs.push(config);
    }
    async connect(): Promise<{ release(): void }> {
      pgHarness.poolLeases += 1;
      return {
        release: () => {
          pgHarness.poolReleases += 1;
        },
      };
    }
    async end(): Promise<void> {
      pgHarness.poolEnded = true;
    }
  }
  return { Client, Pool };
});

const mysqlHarness = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
  connectError: undefined as unknown,
}));

vi.mock("mysql2/promise", () => ({
  createConnection: vi.fn(async (config: Record<string, unknown>) => {
    mysqlHarness.configs.push(config);
    if (mysqlHarness.connectError !== undefined) {
      throw mysqlHarness.connectError;
    }
    return { end: async () => {} };
  }),
}));

const mssqlHarness = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
  connectError: undefined as unknown,
}));

vi.mock("mssql", () => {
  class ConnectionPool {
    constructor(public config: Record<string, unknown>) {
      mssqlHarness.configs.push(config);
    }
    async connect(): Promise<this> {
      if (mssqlHarness.connectError !== undefined) {
        throw mssqlHarness.connectError;
      }
      return this;
    }
    async close(): Promise<void> {}
  }
  return { ConnectionPool };
});

const oracleHarness = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
  connectError: undefined as unknown,
  hang: false,
}));

vi.mock("oracledb", () => ({
  getConnection: vi.fn(async (config: Record<string, unknown>) => {
    oracleHarness.configs.push(config);
    if (oracleHarness.hang) {
      // Never resolves on its own; the only live timer is withTimeout's, so the
      // race is fully deterministic under fake timers.
      return new Promise<never>(() => {});
    }
    if (oracleHarness.connectError !== undefined) {
      throw oracleHarness.connectError;
    }
    return { close: async () => {} };
  }),
}));

const databricksHarness = vi.hoisted(() => ({
  connectOptions: [] as Record<string, unknown>[],
  sessionOptions: [] as (Record<string, unknown> | undefined)[],
  connectError: undefined as unknown,
  sessionHang: false,
}));

vi.mock("@databricks/sql", () => {
  class DBSQLClient {
    async connect(options: Record<string, unknown>): Promise<this> {
      databricksHarness.connectOptions.push(options);
      if (databricksHarness.connectError !== undefined) {
        throw databricksHarness.connectError;
      }
      return this;
    }
    async openSession(options?: Record<string, unknown>): Promise<{ close(): Promise<void> }> {
      databricksHarness.sessionOptions.push(options);
      if (databricksHarness.sessionHang) {
        return new Promise<never>(() => {});
      }
      return { close: async () => {} };
    }
  }
  return { DBSQLClient };
});

const rdsHarness = vi.hoisted(() => ({
  signerArgs: [] as unknown[],
  token: "rds-iam-token",
  fail: false,
}));

vi.mock("@aws-sdk/rds-signer", () => {
  class Signer {
    constructor(public config: unknown) {
      rdsHarness.signerArgs.push(config);
    }
    async getAuthToken(): Promise<string> {
      if (rdsHarness.fail) {
        throw new Error("sts unavailable");
      }
      return rdsHarness.token;
    }
  }
  return { Signer };
});

const azureHarness = vi.hoisted(() => ({
  ctorArgs: [] as unknown[][],
  token: "aad-token",
  tokenFail: false,
}));

vi.mock("@azure/identity", () => {
  class ClientSecretCredential {
    constructor(...args: unknown[]) {
      azureHarness.ctorArgs.push(["service-principal", ...args]);
    }
    async getToken(): Promise<{ token: string }> {
      if (azureHarness.tokenFail) {
        throw new Error("AAD token endpoint unreachable");
      }
      return { token: azureHarness.token };
    }
  }
  class ManagedIdentityCredential {
    constructor(...args: unknown[]) {
      azureHarness.ctorArgs.push(["managed", ...args]);
    }
    async getToken(): Promise<{ token: string }> {
      if (azureHarness.tokenFail) {
        throw new Error("AAD token endpoint unreachable");
      }
      return { token: azureHarness.token };
    }
  }
  return { ClientSecretCredential, ManagedIdentityCredential };
});

afterEach(() => {
  pgHarness.configs.length = 0;
  pgHarness.connectError = undefined;
  pgHarness.poolConfigs.length = 0;
  pgHarness.poolLeases = 0;
  pgHarness.poolReleases = 0;
  pgHarness.poolEnded = false;
  mysqlHarness.configs.length = 0;
  mysqlHarness.connectError = undefined;
  mssqlHarness.configs.length = 0;
  mssqlHarness.connectError = undefined;
  oracleHarness.configs.length = 0;
  oracleHarness.connectError = undefined;
  oracleHarness.hang = false;
  databricksHarness.connectOptions.length = 0;
  databricksHarness.sessionOptions.length = 0;
  databricksHarness.connectError = undefined;
  databricksHarness.sessionHang = false;
  rdsHarness.signerArgs.length = 0;
  rdsHarness.fail = false;
  azureHarness.ctorArgs.length = 0;
  azureHarness.tokenFail = false;
});

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

describe("parseSqlUrl", () => {
  it("parses a full URL with scheme, decoding credentials", () => {
    const p = parseSqlUrl("postgresql+psycopg://us%40r:p%40ss@db.example:5433/app", 5432);
    expect(p).toEqual({
      host: "db.example",
      port: 5433,
      user: "us@r",
      password: "p@ss",
      database: "app",
    });
  });

  it("accepts a schemeless authority and applies the default port", () => {
    const p = parseSqlUrl("user:pass@host/db", 5432);
    expect(p.host).toBe("host");
    expect(p.port).toBe(5432);
    expect(p.user).toBe("user");
    expect(p.database).toBe("db");
  });

  it("returns undefined database when path is absent", () => {
    const p = parseSqlUrl("host:3306", 3306);
    expect(p.database).toBeUndefined();
    expect(p.port).toBe(3306);
    expect(p.user).toBeUndefined();
  });

  it("throws CloudRiftError when no host can be parsed", () => {
    expect(() => parseSqlUrl("///nohost")).toThrow(CloudRiftError);
  });
});

describe("buildSqlalchemyUrl", () => {
  it("percent-encodes credentials and includes the database", () => {
    const url = buildSqlalchemyUrl("mysql+aiomysql", {
      host: "host",
      port: 3306,
      user: "user",
      password: "p@ss",
      database: "db",
    });
    expect(url).toBe("mysql+aiomysql://user:p%40ss@host:3306/db");
  });

  it("omits auth and path when user/database are absent", () => {
    const url = buildSqlalchemyUrl("postgresql+psycopg", { host: "host", port: 5432 });
    expect(url).toBe("postgresql+psycopg://host:5432");
  });
});

/* ------------------------------------------------------------------ */
/* Provider dispatch                                                   */
/* ------------------------------------------------------------------ */

describe("getSql dispatch", () => {
  it("resolves postgres aliases to PostgresSQLBackend", () => {
    const opts = { host: "h", port: 5432, user: "u", password: "p", database: "d" };
    expect(getSql("postgres", "from_credentials", opts)).toBeInstanceOf(PostgresSQLBackend);
    expect(getSql("postgresql", "from_credentials", opts)).toBeInstanceOf(PostgresSQLBackend);
  });

  it("resolves redshift to RedshiftSQLBackend", () => {
    const backend = getSql("redshift", "from_credentials", {
      host: "h",
      port: 5439,
      user: "u",
      password: "p",
      database: "d",
    });
    expect(backend).toBeInstanceOf(RedshiftSQLBackend);
    expect(backend.dialect).toBe("redshift");
  });

  it("resolves mysql / mssql aliases / oracle / databricks", () => {
    expect(
      getSql("mysql", "from_credentials", {
        host: "h",
        port: 3306,
        user: "u",
        password: "p",
        database: "d",
      }),
    ).toBeInstanceOf(MySQLSQLBackend);
    const mssqlOpts = { server: "s", database: "d", username: "u", password: "p" };
    expect(getSql("mssql", "from_credentials", mssqlOpts)).toBeInstanceOf(MSSQLSQLBackend);
    expect(getSql("azuresql", "from_credentials", mssqlOpts)).toBeInstanceOf(MSSQLSQLBackend);
    expect(getSql("sqlserver", "from_credentials", mssqlOpts)).toBeInstanceOf(MSSQLSQLBackend);
    expect(
      getSql("oracle", "from_credentials", {
        host: "h",
        username: "u",
        password: "p",
        serviceName: "svc",
      }),
    ).toBeInstanceOf(OracleSQLBackend);
    expect(
      getSql("databricks", "from_token", { host: "h", httpPath: "/sql", token: "t" }),
    ).toBeInstanceOf(DatabricksSQLBackend);
  });

  it("infers Entra auth methods on mssql", () => {
    const backend = getSql("azuresql", "from_entra_service_principal", {
      server: "s",
      database: "d",
      tenantId: "t",
      clientId: "c",
      clientSecret: "x",
    });
    expect(backend).toBeInstanceOf(MSSQLSQLBackend);
  });

  it("throws CloudRiftError for an unknown provider", () => {
    expect(() => getSql("snowflake", "from_credentials", {})).toThrow(CloudRiftError);
  });

  it("throws CloudRiftError for an unknown auth method", () => {
    expect(() => getSql("postgres", "from_magic", {})).toThrow(/no auth method/);
  });
});

/* ------------------------------------------------------------------ */
/* PostgreSQL                                                          */
/* ------------------------------------------------------------------ */

describe("PostgresSQLBackend", () => {
  it("connects with credentials and applies the timeout", async () => {
    const backend = PostgresSQLBackend.fromCredentials({
      host: "db",
      port: 5432,
      user: "u",
      password: "p",
      database: "app",
    });
    await backend.connect(10);
    const cfg = pgHarness.configs[0];
    expect(cfg.host).toBe("db");
    expect(cfg.user).toBe("u");
    expect(cfg.password).toBe("p");
    expect(cfg.database).toBe("app");
    expect(cfg.connectionTimeoutMillis).toBe(10_000);
  });

  it("fromUrl parses the DSN", async () => {
    const backend = PostgresSQLBackend.fromUrl({ url: "postgres://u:p@db:5544/app" });
    await backend.connect();
    expect(pgHarness.configs[0].port).toBe(5544);
    expect(pgHarness.configs[0].database).toBe("app");
  });

  it("fromUrl leaves missing user/password/database undefined (driver defaults)", async () => {
    const backend = PostgresSQLBackend.fromUrl({ url: "db:5544" });
    await backend.connect();
    const cfg = pgHarness.configs[0];
    expect(cfg.host).toBe("db");
    expect(cfg.user).toBeUndefined();
    expect(cfg.password).toBeUndefined();
    expect(cfg.database).toBeUndefined();
  });

  it("IAM auth uses a fresh RDS token as the password and forces ssl", async () => {
    const backend = PostgresSQLBackend.fromIamAuth({
      host: "rds.aws",
      port: 5432,
      user: "iamuser",
      database: "app",
      region: "us-east-1",
    });
    await backend.connect();
    expect(pgHarness.configs[0].password).toBe("rds-iam-token");
    expect(pgHarness.configs[0].ssl).toEqual({ rejectUnauthorized: false });
    expect(rdsHarness.signerArgs[0]).toMatchObject({
      hostname: "rds.aws",
      port: 5432,
      username: "iamuser",
      region: "us-east-1",
    });
  });

  it("maps a token-generation failure to SQLAuthError", async () => {
    rdsHarness.fail = true;
    const backend = PostgresSQLBackend.fromIamAuth({
      host: "rds.aws",
      port: 5432,
      user: "iamuser",
      database: "app",
      region: "us-east-1",
    });
    await expect(backend.connect()).rejects.toBeInstanceOf(SQLAuthError);
  });

  it("maps a driver connect failure to SQLConnectionError", async () => {
    pgHarness.connectError = new Error("refused");
    const backend = PostgresSQLBackend.fromCredentials({
      host: "db",
      port: 5432,
      user: "u",
      password: "p",
      database: "app",
    });
    await expect(backend.connect()).rejects.toBeInstanceOf(SQLConnectionError);
  });

  it("sqlalchemyUrl builds a percent-encoded URL but rejects IAM auth", () => {
    const creds = PostgresSQLBackend.fromCredentials({
      host: "db",
      port: 5432,
      user: "u",
      password: "p@ss",
      database: "app",
    });
    expect(creds.sqlalchemyUrl()).toBe("postgresql+psycopg://u:p%40ss@db:5432/app");
    const iam = PostgresSQLBackend.fromIamAuth({
      host: "db",
      port: 5432,
      user: "u",
      database: "app",
      region: "us-east-1",
    });
    expect(() => iam.sqlalchemyUrl()).toThrow(SQLAuthError);
  });

  it("Redshift defaults client_encoding to utf8", async () => {
    const backend = RedshiftSQLBackend.fromCredentials({
      host: "rs",
      port: 5439,
      user: "u",
      password: "p",
      database: "app",
    });
    await backend.connect();
    expect(pgHarness.configs[0].client_encoding).toBe("utf8");
  });

  it("Redshift fromUrl returns a RedshiftSQLBackend and parses the DSN (default port 5439)", async () => {
    const withPort = RedshiftSQLBackend.fromUrl({ url: "redshift://u:p@rs.aws:5439/dw" });
    expect(withPort).toBeInstanceOf(RedshiftSQLBackend);
    expect(withPort.dialect).toBe("redshift");
    await withPort.connect();
    expect(pgHarness.configs[0].host).toBe("rs.aws");
    expect(pgHarness.configs[0].port).toBe(5439);
    expect(pgHarness.configs[0].database).toBe("dw");

    pgHarness.configs.length = 0;
    // Redshift inherits PostgresSQLBackend.fromUrl, whose default port is 5432;
    // a portless DSN therefore falls back to 5432 (parity with the base class).
    const noPort = RedshiftSQLBackend.fromUrl({ url: "u:p@rs.aws/dw" });
    await noPort.connect();
    expect(pgHarness.configs[0].port).toBe(5432);
  });

  it("Redshift fromIamAuth mints a fresh token and forces ssl", async () => {
    const backend = RedshiftSQLBackend.fromIamAuth({
      host: "rs.aws",
      port: 5439,
      user: "iamuser",
      database: "dw",
      region: "us-east-1",
    });
    expect(backend).toBeInstanceOf(RedshiftSQLBackend);
    await backend.connect();
    expect(pgHarness.configs[0].password).toBe("rds-iam-token");
    expect(pgHarness.configs[0].ssl).toEqual({ rejectUnauthorized: false });
    expect(rdsHarness.signerArgs[0]).toMatchObject({
      hostname: "rs.aws",
      port: 5439,
      username: "iamuser",
      region: "us-east-1",
    });
  });

  it("withConnection tears down the native connection afterward (via end())", async () => {
    const backend = PostgresSQLBackend.fromCredentials({
      host: "db",
      port: 5432,
      user: "u",
      password: "p",
      database: "app",
    });
    let closed = false;
    const result = await backend.withConnection(async (conn) => {
      // pg.Client exposes end(), not close(); the base helper must call it.
      (conn as { end: () => Promise<void> }).end = async () => {
        closed = true;
      };
      return "ok";
    });
    expect(result).toBe("ok");
    expect(closed).toBe(true);
  });

  it("pooled mode leases and releases a connection (and close() ends the pool)", async () => {
    const backend = PostgresSQLBackend.fromCredentials({
      host: "db",
      port: 5432,
      user: "u",
      password: "p",
      database: "app",
      pool: true,
      poolMinSize: 2,
      poolMaxSize: 7,
    });
    const result = await backend.withConnection(async () => "ok");
    expect(result).toBe("ok");
    // No standalone Client connection was opened; the pool was used instead.
    expect(pgHarness.configs.length).toBe(0);
    expect(pgHarness.poolConfigs.length).toBe(1);
    expect(pgHarness.poolConfigs[0]).toMatchObject({ min: 2, max: 7, host: "db", user: "u" });
    expect(pgHarness.poolLeases).toBe(1);
    expect(pgHarness.poolReleases).toBe(1);
    // A second lease reuses the same pool (no new Pool constructed).
    await backend.withConnection(async () => "ok2");
    expect(pgHarness.poolConfigs.length).toBe(1);
    expect(pgHarness.poolLeases).toBe(2);
    await backend.close();
    expect(pgHarness.poolEnded).toBe(true);
  });

  it("unpooled mode opens a standalone connection, not a pool", async () => {
    const backend = PostgresSQLBackend.fromCredentials({
      host: "db",
      port: 5432,
      user: "u",
      password: "p",
      database: "app",
    });
    await backend.withConnection(async () => "ok");
    expect(pgHarness.configs.length).toBe(1);
    expect(pgHarness.poolConfigs.length).toBe(0);
    expect(pgHarness.poolLeases).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* MySQL                                                               */
/* ------------------------------------------------------------------ */

describe("MySQLSQLBackend", () => {
  it("connects with credentials and a converted timeout", async () => {
    const backend = MySQLSQLBackend.fromCredentials({
      host: "db",
      port: 3306,
      user: "u",
      password: "p",
      database: "app",
    });
    await backend.connect(5);
    expect(mysqlHarness.configs[0]).toMatchObject({
      host: "db",
      port: 3306,
      user: "u",
      password: "p",
      database: "app",
      connectTimeout: 5000,
    });
  });

  it("IAM auth uses a fresh RDS token", async () => {
    const backend = MySQLSQLBackend.fromIamAuth({
      host: "rds.aws",
      port: 3306,
      user: "iamuser",
      database: "app",
      region: "eu-west-1",
    });
    await backend.connect();
    expect(mysqlHarness.configs[0].password).toBe("rds-iam-token");
  });

  it("fromUrl applies the default port", async () => {
    const backend = MySQLSQLBackend.fromUrl({ url: "u:p@db/app" });
    await backend.connect();
    expect(mysqlHarness.configs[0].port).toBe(3306);
  });

  it("maps a driver connect failure to SQLConnectionError", async () => {
    mysqlHarness.connectError = new Error("ECONNREFUSED");
    const backend = MySQLSQLBackend.fromCredentials({
      host: "db",
      port: 3306,
      user: "u",
      password: "p",
      database: "app",
    });
    await expect(backend.connect()).rejects.toBeInstanceOf(SQLConnectionError);
  });

  it("maps an IAM rdsToken failure to SQLAuthError (not SQLConnectionError)", async () => {
    rdsHarness.fail = true;
    const backend = MySQLSQLBackend.fromIamAuth({
      host: "rds.aws",
      port: 3306,
      user: "iamuser",
      database: "app",
      region: "eu-west-1",
    });
    // The signer throws first, so the auth error must not be masked as a
    // connection error by the surrounding try/catch.
    await expect(backend.connect()).rejects.toBeInstanceOf(SQLAuthError);
    // The driver was never reached.
    expect(mysqlHarness.configs.length).toBe(0);
  });

  it("sqlalchemyUrl builds a percent-encoded URL but rejects IAM auth", () => {
    const creds = MySQLSQLBackend.fromCredentials({
      host: "db",
      port: 3306,
      user: "u",
      password: "p@ss",
      database: "app",
    });
    expect(creds.sqlalchemyUrl()).toBe("mysql+aiomysql://u:p%40ss@db:3306/app");
    // A custom driver scheme overrides the default.
    expect(creds.sqlalchemyUrl("mysql+pymysql")).toBe("mysql+pymysql://u:p%40ss@db:3306/app");
    const iam = MySQLSQLBackend.fromIamAuth({
      host: "db",
      port: 3306,
      user: "u",
      database: "app",
      region: "eu-west-1",
    });
    expect(() => iam.sqlalchemyUrl()).toThrow(SQLAuthError);
  });
});

/* ------------------------------------------------------------------ */
/* MSSQL                                                               */
/* ------------------------------------------------------------------ */

describe("MSSQLSQLBackend", () => {
  it("credentials auth supplies user/password and encrypt defaults", async () => {
    const backend = MSSQLSQLBackend.fromCredentials({
      server: "sql.example",
      database: "app",
      username: "sa",
      password: "secret",
    });
    await backend.connect(15);
    const cfg = mssqlHarness.configs[0];
    expect(cfg.server).toBe("sql.example");
    expect(cfg.user).toBe("sa");
    expect(cfg.password).toBe("secret");
    expect(cfg.connectionTimeout).toBe(15_000);
    expect(cfg.options).toMatchObject({ encrypt: true, trustServerCertificate: false });
    expect(cfg.authentication).toBeUndefined();
  });

  it("explicit timeout arg wins over connectionKwargs.connectionTimeout", async () => {
    const backend = MSSQLSQLBackend.fromCredentials({
      server: "sql.example",
      database: "app",
      username: "sa",
      password: "secret",
      connectionKwargs: { connectionTimeout: 99_000 },
    });
    await backend.connect(15);
    expect(mssqlHarness.configs[0].connectionTimeout).toBe(15_000);
  });

  it("falls back to connectionKwargs.connectionTimeout when no explicit arg", async () => {
    const backend = MSSQLSQLBackend.fromCredentials({
      server: "sql.example",
      database: "app",
      username: "sa",
      password: "secret",
      connectionKwargs: { connectionTimeout: 99_000 },
    });
    await backend.connect();
    expect(mssqlHarness.configs[0].connectionTimeout).toBe(99_000);
  });

  it("service-principal auth attaches an AAD access token", async () => {
    const backend = MSSQLSQLBackend.fromEntraServicePrincipal({
      server: "sql.example",
      database: "app",
      tenantId: "tid",
      clientId: "cid",
      clientSecret: "sec",
    });
    await backend.connect();
    const cfg = mssqlHarness.configs[0];
    expect(cfg.user).toBeUndefined();
    expect(cfg.authentication).toEqual({
      type: "azure-active-directory-access-token",
      options: { token: "aad-token" },
    });
    expect(azureHarness.ctorArgs[0]).toEqual(["service-principal", "tid", "cid", "sec"]);
  });

  it("managed-identity auth uses ManagedIdentityCredential", async () => {
    const backend = MSSQLSQLBackend.fromEntraManagedIdentity({
      server: "sql.example",
      database: "app",
      clientId: "uami",
    });
    await backend.connect();
    expect(azureHarness.ctorArgs[0]).toEqual(["managed", "uami"]);
    expect(
      (mssqlHarness.configs[0].authentication as { options: { token: string } }).options.token,
    ).toBe("aad-token");
  });

  it("rejects pooling under token auth (SQLConnectionError) while credential pooling works", async () => {
    // Credential auth supports pooling: withConnection must succeed and build a
    // pool config carrying min/max.
    const pooled = MSSQLSQLBackend.fromCredentials({
      server: "s",
      database: "d",
      username: "u",
      password: "p",
      pool: true,
      poolMinSize: 3,
      poolMaxSize: 9,
    });
    await expect(pooled.withConnection(async (c) => c)).resolves.toBeDefined();
    expect(mssqlHarness.configs[0]!.pool).toEqual({ min: 3, max: 9 });

    // Token auth cannot share a static pool. Construct a token-auth backend and
    // force the pool path by flipping its private `pool` flag; ensurePool must
    // throw SQLConnectionError BEFORE any ConnectionPool is constructed.
    mssqlHarness.configs.length = 0;
    const tokenBackend = MSSQLSQLBackend.fromEntraServicePrincipal({
      server: "sql.example",
      database: "app",
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
    });
    (tokenBackend as unknown as { init: { pool: boolean } }).init.pool = true;
    await expect(tokenBackend.withConnection(async (c) => c)).rejects.toBeInstanceOf(
      SQLConnectionError,
    );
    // No pool/connection was created for the rejected token-auth path.
    expect(mssqlHarness.configs.length).toBe(0);
  });

  it("maps a driver connect failure to SQLConnectionError", async () => {
    mssqlHarness.connectError = new Error("login failed");
    const backend = MSSQLSQLBackend.fromCredentials({
      server: "sql.example",
      database: "app",
      username: "sa",
      password: "secret",
    });
    await expect(backend.connect()).rejects.toBeInstanceOf(SQLConnectionError);
  });

  it("maps an Entra token-acquisition failure to SQLAuthError (not SQLConnectionError)", async () => {
    azureHarness.tokenFail = true;
    const backend = MSSQLSQLBackend.fromEntraServicePrincipal({
      server: "sql.example",
      database: "app",
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
    });
    // buildConfig() acquires the token; its failure must surface as SQLAuthError
    // and not be re-wrapped as a connection error by connect()'s catch.
    await expect(backend.connect()).rejects.toBeInstanceOf(SQLAuthError);
    // The driver pool was never constructed (token failed before connect()).
    expect(mssqlHarness.configs.length).toBe(0);
  });

  it("serverCertificate pinning throws (not implemented in TS)", async () => {
    const backend = MSSQLSQLBackend.fromCredentials({
      server: "sql.example",
      database: "app",
      username: "sa",
      password: "secret",
      serverCertificate: "-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----",
    });
    await expect(backend.connect()).rejects.toBeInstanceOf(SQLConnectionError);
  });
});

describe("validatePinnedCertificate", () => {
  it("throws SQLConnectionError (not implemented)", async () => {
    await expect(validatePinnedCertificate("h", 1433, "pem")).rejects.toBeInstanceOf(
      SQLConnectionError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Oracle                                                              */
/* ------------------------------------------------------------------ */

describe("OracleSQLBackend", () => {
  it("builds an Easy Connect string with service_name", async () => {
    const backend = OracleSQLBackend.fromCredentials({
      host: "oracle.example",
      username: "scott",
      password: "tiger",
      serviceName: "ORCLPDB1",
    });
    await backend.connect();
    expect(oracleHarness.configs[0]).toMatchObject({
      user: "scott",
      password: "tiger",
      connectString: "tcp://oracle.example:1521/ORCLPDB1",
    });
  });

  it("uses sid form and wallet location when provided", async () => {
    const backend = OracleSQLBackend.fromCredentials({
      host: "oracle.example",
      username: "scott",
      password: "tiger",
      port: 2484,
      protocol: "tcps",
      sid: "ORCL",
      walletPath: "/wallet",
      walletPassword: "wpw",
    });
    await backend.connect();
    expect(oracleHarness.configs[0]).toMatchObject({
      connectString:
        "(DESCRIPTION=(ADDRESS=(PROTOCOL=tcps)(HOST=oracle.example)(PORT=2484))" +
        "(CONNECT_DATA=(SID=ORCL)))",
      walletLocation: "/wallet",
      configDir: "/wallet",
      walletPassword: "wpw",
    });
  });

  it("maps a driver connect failure to SQLConnectionError", async () => {
    oracleHarness.connectError = new Error("ORA-12541: no listener");
    const backend = OracleSQLBackend.fromCredentials({
      host: "oracle.example",
      username: "scott",
      password: "tiger",
      serviceName: "ORCLPDB1",
    });
    await expect(backend.connect()).rejects.toBeInstanceOf(SQLConnectionError);
  });

  it("withTimeout resolves when the connection beats the timeout", async () => {
    const backend = OracleSQLBackend.fromCredentials({
      host: "oracle.example",
      username: "scott",
      password: "tiger",
      serviceName: "ORCLPDB1",
    });
    // getConnection resolves immediately; a generous timeout must not fire.
    await expect(backend.connect(30)).resolves.toBeDefined();
  });

  it("withTimeout rejects with SQLConnectionError when the connection is too slow", async () => {
    // getConnection never resolves; the (sub-)1ms timeout must win the race.
    oracleHarness.hang = true;
    const backend = OracleSQLBackend.fromCredentials({
      host: "oracle.example",
      username: "scott",
      password: "tiger",
      serviceName: "ORCLPDB1",
    });
    await expect(backend.connect(0.001)).rejects.toBeInstanceOf(SQLConnectionError);
  });
});

/* ------------------------------------------------------------------ */
/* Databricks                                                          */
/* ------------------------------------------------------------------ */

describe("DatabricksSQLBackend", () => {
  it("connects with token and passes catalog/schema as session options", async () => {
    const backend = DatabricksSQLBackend.fromToken({
      host: "dbc.example.com",
      httpPath: "/sql/1.0/warehouses/abc",
      token: "dapiXXXX",
      catalog: "main",
      schema: "default",
    });
    await backend.connect();
    expect(databricksHarness.connectOptions[0]).toMatchObject({
      host: "dbc.example.com",
      path: "/sql/1.0/warehouses/abc",
      token: "dapiXXXX",
    });
    expect(databricksHarness.sessionOptions[0]).toEqual({
      initialCatalog: "main",
      initialSchema: "default",
    });
  });

  it("folds a non-default port into the host", async () => {
    const backend = DatabricksSQLBackend.fromToken({
      host: "dbc.example.com",
      httpPath: "/sql",
      token: "t",
      port: 8443,
    });
    await backend.connect();
    expect(databricksHarness.connectOptions[0].host).toBe("dbc.example.com:8443");
    expect(databricksHarness.sessionOptions[0]).toBeUndefined();
  });

  it("maps a connect failure to SQLConnectionError", async () => {
    databricksHarness.connectError = new Error("403 invalid token");
    const backend = DatabricksSQLBackend.fromToken({
      host: "dbc.example.com",
      httpPath: "/sql",
      token: "bad",
    });
    await expect(backend.connect()).rejects.toBeInstanceOf(SQLConnectionError);
  });

  it("withTimeout resolves when the session opens before the timeout", async () => {
    const backend = DatabricksSQLBackend.fromToken({
      host: "dbc.example.com",
      httpPath: "/sql",
      token: "t",
    });
    await expect(backend.connect(30)).resolves.toBeDefined();
  });

  it("withTimeout rejects with SQLConnectionError when opening the session is too slow", async () => {
    // openSession never resolves; the (sub-)1ms timeout must win the race.
    databricksHarness.sessionHang = true;
    const backend = DatabricksSQLBackend.fromToken({
      host: "dbc.example.com",
      httpPath: "/sql",
      token: "t",
    });
    await expect(backend.connect(0.001)).rejects.toBeInstanceOf(SQLConnectionError);
  });
});
