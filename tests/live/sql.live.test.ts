/**
 * SQL live connection tests (AWS RDS PostgreSQL, RDS MySQL, Redshift).
 *
 * cloudrift's SQL layer abstracts connection construction + cloud auth and hands
 * back a NATIVE driver connection (it does not wrap query execution). So each
 * test exercises the real path the way a consumer would: getSql(...) ->
 * connect() -> a trivial native driver query (SELECT 1) -> assert the result ->
 * close the connection.
 *
 * Gated on CLOUDRIFT_LIVE_TESTS=1 plus the per-provider env + allowlist gates in
 * ./env.ts; each describe SKIPS (never fails) when its creds are absent. The IAM
 * blocks deliberately exercise the real STS/`@aws-sdk/rds-signer` token path
 * that the unit lane only mocks.
 *
 * No resources are created server-side — these only OPEN connections. Every
 * connection is closed in a finally so a query failure never leaks a socket; the
 * backend itself is closed in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getSql } from "../../src/index.js";
import type { SQLBackend, SqlConnection } from "../../src/index.js";
import {
  env,
  getRdsMysqlConfig,
  getRdsPostgresConfig,
  getRedshiftConfig,
  liveLog,
  RDS_MYSQL_IAM_PRESENT,
  RDS_MYSQL_PRESENT,
  RDS_POSTGRES_IAM_PRESENT,
  RDS_POSTGRES_PRESENT,
  REDSHIFT_PRESENT,
} from "./env.js";

const REGION = env("CLOUDRIFT_LIVE_AWS_REGION");

/** Close a native driver connection, swallowing teardown errors. */
async function closeConnection(conn: SqlConnection | undefined): Promise<void> {
  if (conn === undefined || conn === null) {
    return;
  }
  const c = conn as {
    close?: () => unknown;
    end?: () => unknown;
    destroy?: () => unknown;
  };
  const teardown = c.close ?? c.end ?? c.destroy;
  if (typeof teardown === "function") {
    await teardown.call(conn);
  }
}

/** Run a query on a `pg.Client`-shaped connection and return its rows. */
async function pgQuery(conn: SqlConnection, sql: string): Promise<Array<Record<string, unknown>>> {
  const client = conn as { query(text: string): Promise<{ rows: Array<Record<string, unknown>> }> };
  const result = await client.query(sql);
  return result.rows;
}

/** Run a query on a `mysql2/promise` connection and return its rows. */
async function mysqlQuery(
  conn: SqlConnection,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const connection = conn as {
    query(text: string): Promise<[Array<Record<string, unknown>>, unknown]>;
  };
  const [rows] = await connection.query(sql);
  return rows;
}

/* ================================================================== */
/* RDS PostgreSQL — password auth                                     */
/* ================================================================== */

describe.skipIf(!RDS_POSTGRES_PRESENT)("AWS RDS PostgreSQL live (password auth)", () => {
  const log = liveLog("sql:rds-postgres");
  const cfg = getRdsPostgresConfig();
  let backend: SQLBackend | undefined;
  let conn: SqlConnection | undefined;

  beforeAll(() => {
    log.step("initializing backend", { provider: "postgres", host: cfg.host, port: cfg.port });
    backend = getSql("postgres", "from_credentials", {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
    });
  });

  afterAll(async () => {
    try {
      await closeConnection(conn);
    } catch (err) {
      log.warn("connection close failed", err, { host: cfg.host });
    }
    try {
      await backend?.close();
      log.step("closed backend", { host: cfg.host });
    } catch (err) {
      log.warn("backend close failed", err, { host: cfg.host });
    }
  });

  it("connects and runs SELECT 1", async () => {
    expect(backend).toBeDefined();
    log.step("connecting", { host: cfg.host, port: cfg.port });
    conn = await backend!.connect(15);
    log.step("connected", { host: cfg.host });

    const rows = await pgQuery(conn, "SELECT 1 AS value");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].value)).toBe(1);
    log.step("query ok", { host: cfg.host, rows: rows.length });
  });
});

/* ================================================================== */
/* RDS PostgreSQL — IAM auth (real STS / rds-signer path)             */
/* ================================================================== */

describe.skipIf(!RDS_POSTGRES_IAM_PRESENT)("AWS RDS PostgreSQL live (IAM auth)", () => {
  const log = liveLog("sql:rds-postgres-iam");
  const cfg = getRdsPostgresConfig();
  let backend: SQLBackend | undefined;
  let conn: SqlConnection | undefined;

  beforeAll(() => {
    log.step("initializing backend", {
      provider: "postgres",
      host: cfg.host,
      iamUser: cfg.iamUser,
    });
    backend = getSql("postgres", "from_iam_auth", {
      host: cfg.host,
      port: cfg.port,
      user: cfg.iamUser,
      database: cfg.database,
      region: REGION,
    });
  });

  afterAll(async () => {
    try {
      await closeConnection(conn);
    } catch (err) {
      log.warn("connection close failed", err, { host: cfg.host });
    }
    try {
      await backend?.close();
      log.step("closed backend", { host: cfg.host });
    } catch (err) {
      log.warn("backend close failed", err, { host: cfg.host });
    }
  });

  it("mints an IAM token, connects, and runs SELECT 1", async () => {
    expect(backend).toBeDefined();
    log.step("connecting (IAM token)", { host: cfg.host, port: cfg.port });
    conn = await backend!.connect(15);
    log.step("connected", { host: cfg.host });

    const rows = await pgQuery(conn, "SELECT 1 AS value");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].value)).toBe(1);
    log.step("query ok", { host: cfg.host, rows: rows.length });
  });
});

/* ================================================================== */
/* RDS MySQL — password auth                                          */
/* ================================================================== */

describe.skipIf(!RDS_MYSQL_PRESENT)("AWS RDS MySQL live (password auth)", () => {
  const log = liveLog("sql:rds-mysql");
  const cfg = getRdsMysqlConfig();
  let backend: SQLBackend | undefined;
  let conn: SqlConnection | undefined;

  beforeAll(() => {
    log.step("initializing backend", { provider: "mysql", host: cfg.host, port: cfg.port });
    backend = getSql("mysql", "from_credentials", {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
    });
  });

  afterAll(async () => {
    try {
      await closeConnection(conn);
    } catch (err) {
      log.warn("connection close failed", err, { host: cfg.host });
    }
    try {
      await backend?.close();
      log.step("closed backend", { host: cfg.host });
    } catch (err) {
      log.warn("backend close failed", err, { host: cfg.host });
    }
  });

  it("connects and runs SELECT 1", async () => {
    expect(backend).toBeDefined();
    log.step("connecting", { host: cfg.host, port: cfg.port });
    conn = await backend!.connect(15);
    log.step("connected", { host: cfg.host });

    const rows = await mysqlQuery(conn, "SELECT 1 AS value");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].value)).toBe(1);
    log.step("query ok", { host: cfg.host, rows: rows.length });
  });
});

/* ================================================================== */
/* RDS MySQL — IAM auth (real STS / rds-signer path)                  */
/* ================================================================== */

describe.skipIf(!RDS_MYSQL_IAM_PRESENT)("AWS RDS MySQL live (IAM auth)", () => {
  const log = liveLog("sql:rds-mysql-iam");
  const cfg = getRdsMysqlConfig();
  let backend: SQLBackend | undefined;
  let conn: SqlConnection | undefined;

  beforeAll(() => {
    log.step("initializing backend", { provider: "mysql", host: cfg.host, iamUser: cfg.iamUser });
    backend = getSql("mysql", "from_iam_auth", {
      host: cfg.host,
      port: cfg.port,
      user: cfg.iamUser,
      database: cfg.database,
      region: REGION,
      // RDS IAM auth requires TLS; the public CA is trusted by the host already.
      connectKwargs: { ssl: { rejectUnauthorized: false } },
    });
  });

  afterAll(async () => {
    try {
      await closeConnection(conn);
    } catch (err) {
      log.warn("connection close failed", err, { host: cfg.host });
    }
    try {
      await backend?.close();
      log.step("closed backend", { host: cfg.host });
    } catch (err) {
      log.warn("backend close failed", err, { host: cfg.host });
    }
  });

  it("mints an IAM token, connects, and runs SELECT 1", async () => {
    expect(backend).toBeDefined();
    log.step("connecting (IAM token)", { host: cfg.host, port: cfg.port });
    conn = await backend!.connect(15);
    log.step("connected", { host: cfg.host });

    const rows = await mysqlQuery(conn, "SELECT 1 AS value");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].value)).toBe(1);
    log.step("query ok", { host: cfg.host, rows: rows.length });
  });
});

/* ================================================================== */
/* Redshift (PostgreSQL wire protocol, pg driver)                     */
/* ================================================================== */

describe.skipIf(!REDSHIFT_PRESENT)("AWS Redshift live (password auth)", () => {
  const log = liveLog("sql:redshift");
  const cfg = getRedshiftConfig();
  let backend: SQLBackend | undefined;
  let conn: SqlConnection | undefined;

  beforeAll(() => {
    log.step("initializing backend", { provider: "redshift", host: cfg.host, port: cfg.port });
    backend = getSql("redshift", "from_credentials", {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
    });
  });

  afterAll(async () => {
    try {
      await closeConnection(conn);
    } catch (err) {
      log.warn("connection close failed", err, { host: cfg.host });
    }
    try {
      await backend?.close();
      log.step("closed backend", { host: cfg.host });
    } catch (err) {
      log.warn("backend close failed", err, { host: cfg.host });
    }
  });

  it("connects via the pg driver and runs SELECT 1", async () => {
    expect(backend).toBeDefined();
    log.step("connecting", { host: cfg.host, port: cfg.port });
    conn = await backend!.connect(15);
    log.step("connected", { host: cfg.host });

    const rows = await pgQuery(conn, "SELECT 1 AS value");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].value)).toBe(1);
    log.step("query ok", { host: cfg.host, rows: rows.length });
  });
});
