/**
 * Shared environment gating for the opt-in LIVE test lane.
 *
 * Live tests behave like a tiny consumer app: they read env, instantiate the
 * public factories, run one minimal lifecycle per provider against REAL cloud
 * resources, assert side effects, then clean up aggressively.
 *
 * NOTHING here runs in the default `npm test`. Every `describe` is gated and
 * SKIPS (never fails) when its required env vars are absent.
 *
 * ---------------------------------------------------------------------------
 * Environment variables
 * ---------------------------------------------------------------------------
 * Master switch (required for ANY live test to run):
 *   CLOUDRIFT_LIVE_TESTS=1
 *
 * AWS (region + one auth method; pre-provisioned resources optional):
 *   CLOUDRIFT_LIVE_AWS_REGION              AWS region, e.g. "us-east-1"
 *   CLOUDRIFT_LIVE_AWS_ACCESS_KEY_ID       access-key auth (with secret below)
 *   CLOUDRIFT_LIVE_AWS_SECRET_ACCESS_KEY   access-key auth (with id above)
 *   CLOUDRIFT_LIVE_AWS_SESSION_TOKEN       optional STS session token
 *   CLOUDRIFT_LIVE_AWS_PROFILE             named-profile auth (alternative)
 *   CLOUDRIFT_LIVE_AWS_BUCKET              optional pre-provisioned S3 bucket
 *   CLOUDRIFT_LIVE_AWS_QUEUE_URL           optional pre-provisioned SQS queue URL
 *   CLOUDRIFT_LIVE_AWS_TOPIC_ARN           optional pre-provisioned SNS topic ARN
 *   CLOUDRIFT_LIVE_AWS_SERVICES            optional per-service allowlist. When
 *                                          UNSET/empty, ALL AWS services run
 *                                          (default — unchanged behavior). When
 *                                          set, only the listed services run and
 *                                          the rest SKIP — useful for accounts
 *                                          whose IAM credentials cover only a
 *                                          subset of services. Comma/space-
 *                                          separated, case-insensitive. Accepted
 *                                          tokens: "s3", "sqs", "sns", "secrets"
 *                                          (Secrets Manager), "ses" (SES email),
 *                                          "rds-postgres", "rds-mysql",
 *                                          "redshift". Example:
 *                                          CLOUDRIFT_LIVE_AWS_SERVICES="s3,sqs"
 *
 * AWS SES (email; reuses AWS region + auth above):
 *   CLOUDRIFT_LIVE_AWS_SES_FROM            verified sender address
 *   CLOUDRIFT_LIVE_AWS_SES_TO              verified/sandboxed recipient address
 *
 * AWS SQS FIFO / DLQ (reuses AWS region + auth above):
 *   CLOUDRIFT_LIVE_AWS_FIFO_QUEUE_URL      optional pre-provisioned FIFO queue URL
 *                                          (tests may create one when unset)
 *   CLOUDRIFT_LIVE_AWS_DLQ_URL             optional pre-provisioned dead-letter queue URL
 *
 * AWS RDS PostgreSQL (reuses AWS region + auth above for IAM auth):
 *   CLOUDRIFT_LIVE_AWS_RDS_PG_HOST         endpoint host
 *   CLOUDRIFT_LIVE_AWS_RDS_PG_PORT         port (default 5432)
 *   CLOUDRIFT_LIVE_AWS_RDS_PG_USER         password-auth user
 *   CLOUDRIFT_LIVE_AWS_RDS_PG_PASSWORD     password-auth password
 *   CLOUDRIFT_LIVE_AWS_RDS_PG_DATABASE     database name
 *   CLOUDRIFT_LIVE_AWS_RDS_PG_IAM_USER     optional IAM-auth db user (token auth)
 *
 * AWS RDS MySQL (reuses AWS region + auth above for IAM auth):
 *   CLOUDRIFT_LIVE_AWS_RDS_MYSQL_HOST      endpoint host
 *   CLOUDRIFT_LIVE_AWS_RDS_MYSQL_PORT      port (default 3306)
 *   CLOUDRIFT_LIVE_AWS_RDS_MYSQL_USER      password-auth user
 *   CLOUDRIFT_LIVE_AWS_RDS_MYSQL_PASSWORD  password-auth password
 *   CLOUDRIFT_LIVE_AWS_RDS_MYSQL_DATABASE  database name
 *   CLOUDRIFT_LIVE_AWS_RDS_MYSQL_IAM_USER  optional IAM-auth db user (token auth)
 *
 * AWS Redshift (reuses AWS region + auth above):
 *   CLOUDRIFT_LIVE_AWS_REDSHIFT_HOST       endpoint host
 *   CLOUDRIFT_LIVE_AWS_REDSHIFT_PORT       port (default 5439)
 *   CLOUDRIFT_LIVE_AWS_REDSHIFT_USER       db user
 *   CLOUDRIFT_LIVE_AWS_REDSHIFT_PASSWORD   db password
 *   CLOUDRIFT_LIVE_AWS_REDSHIFT_DATABASE   database name
 *
 * Azure:
 *   CLOUDRIFT_LIVE_AZURE_STORAGE_CONNECTION_STRING   blob storage
 *   CLOUDRIFT_LIVE_AZURE_BLOB_CONTAINER              optional pre-provisioned container
 *   CLOUDRIFT_LIVE_AZURE_KEYVAULT_URL                key vault URL
 *   CLOUDRIFT_LIVE_AZURE_TENANT_ID                   service principal (key vault)
 *   CLOUDRIFT_LIVE_AZURE_CLIENT_ID                   service principal (key vault)
 *   CLOUDRIFT_LIVE_AZURE_CLIENT_SECRET               service principal (key vault)
 *   CLOUDRIFT_LIVE_AZURE_EVENTGRID_ENDPOINT          event grid topic endpoint
 *   CLOUDRIFT_LIVE_AZURE_EVENTGRID_KEY               event grid access key
 *   CLOUDRIFT_LIVE_AZURE_SERVICEBUS_CONNECTION_STRING  service bus
 *   CLOUDRIFT_LIVE_AZURE_SERVICEBUS_QUEUE             service bus queue name
 *   CLOUDRIFT_LIVE_AZURE_SB_SESSION_QUEUE            session-enabled service bus queue name
 *                                                    (reuses the connection string above)
 *
 * Document (MongoDB wire protocol — DocumentDB or Cosmos):
 *   CLOUDRIFT_LIVE_MONGO_URI               connection URI
 *   CLOUDRIFT_LIVE_MONGO_PROVIDER          "documentdb" | "cosmos" (default documentdb)
 *
 * Cache:
 *   CLOUDRIFT_LIVE_REDIS_URL               redis:// or rediss:// URL
 * ---------------------------------------------------------------------------
 */

import { randomBytes } from "node:crypto";

/** Master switch: live tests only ever run when this is exactly "1". */
export const LIVE = process.env.CLOUDRIFT_LIVE_TESTS === "1";

/** Read a non-empty trimmed env var, or `undefined`. */
export function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** True when LIVE is on AND every named env var is present and non-empty. */
export function requireEnv(names: string[]): boolean {
  if (!LIVE) {
    return false;
  }
  return names.every((name) => env(name) !== undefined);
}

export interface LiveLogger {
  step(action: string, fields?: Record<string, unknown>): void;
  warn(action: string, err: unknown, fields?: Record<string, unknown>): void;
}

/**
 * Structured console logging for live tests. Logs are always on when a live
 * group runs because these tests touch real cloud resources.
 */
export function liveLog(scope: string): LiveLogger {
  return {
    step(action: string, fields?: Record<string, unknown>) {
      console.info(formatLiveLog(scope, action, fields));
    },
    warn(action: string, err: unknown, fields?: Record<string, unknown>) {
      console.warn(formatLiveLog(scope, action, { ...fields, error: errorSummary(err) }));
    },
  };
}

function formatLiveLog(scope: string, action: string, fields?: Record<string, unknown>): string {
  const entries = fields === undefined ? [] : Object.entries(fields);
  const metadata =
    entries.length === 0
      ? ""
      : ` ${JSON.stringify(Object.fromEntries(entries.map(([k, v]) => [k, redact(k, v)])))}`;
  return `[live:${scope}] ${action}${metadata}`;
}

function redact(key: string, value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "string") {
    return value;
  }
  if (isSensitiveKey(key)) {
    return "<redacted>";
  }
  if (key.toLowerCase().endsWith("url")) {
    return redactUrl(value);
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /secret|password|token|credential|connectionString|accountKey|accessKey|clientSecret|uri/i.test(
    key,
  );
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/...`;
  } catch {
    return "<redacted-url>";
  }
}

function errorSummary(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

/**
 * Per-service AWS gating selector (does NOT check LIVE or auth — callers
 * combine it with their auth gate).
 *
 * Reads the optional allowlist env var `CLOUDRIFT_LIVE_AWS_SERVICES`
 * (comma/space-separated, case-insensitive). Canonical service tokens are
 * "s3", "sqs", "sns", "secrets" (AWS Secrets Manager), "ses" (SES email),
 * "rds-postgres", "rds-mysql", and "redshift".
 *
 *   - Unset/empty  -> every service is enabled (default, unchanged behavior).
 *   - Set          -> only the listed services are enabled; others are skipped.
 */
export function awsServiceEnabled(service: string): boolean {
  const allowlist = env("CLOUDRIFT_LIVE_AWS_SERVICES");
  if (allowlist === undefined) {
    return true;
  }
  const enabled = new Set(
    allowlist
      .split(/[\s,]+/)
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ""),
  );
  return enabled.has(service.trim().toLowerCase());
}

/**
 * Generate a collision-free, S3-/Mongo-safe resource name for `kind`.
 *
 * Output is lowercase, hyphen-delimited, and contains only `[a-z0-9-]` so it is
 * valid as an S3 bucket name, object key, container name, queue name, secret
 * name, or Mongo collection name.
 */
export function uniqueName(kind: string): string {
  const safeKind = kind
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = randomBytes(6).toString("hex");
  return `cloudrift-live-${safeKind}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Typed config getters for the parity-catchup live tests (SES, RDS, Redshift,
// SQS FIFO/DLQ, Azure Service Bus sessions).
//
// Each getter returns the parsed config (with `undefined` for any missing var)
// and a sibling `*_PRESENT` boolean computed via `requireEnv` so call sites can
// gate with `describe.skipIf(!X_PRESENT)`. These are purely additive and never
// throw; they SKIP cleanly when LIVE is off or vars are absent.
// ---------------------------------------------------------------------------

/** Parse an optional integer env var, falling back to `fallback` when unset/invalid. */
function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** AWS SES (email) config. Reuses AWS region + auth from the AWS block. */
export interface SesLiveConfig {
  from: string | undefined;
  to: string | undefined;
}

export function getSesConfig(): SesLiveConfig {
  return {
    from: env("CLOUDRIFT_LIVE_AWS_SES_FROM"),
    to: env("CLOUDRIFT_LIVE_AWS_SES_TO"),
  };
}

/** True when LIVE on, both SES addresses present, and "ses" allowlisted. */
export const SES_PRESENT =
  requireEnv(["CLOUDRIFT_LIVE_AWS_SES_FROM", "CLOUDRIFT_LIVE_AWS_SES_TO"]) &&
  awsServiceEnabled("ses");

/** Generic relational-DB connection config shared by RDS/Redshift getters. */
export interface SqlLiveConfig {
  host: string | undefined;
  port: number;
  user: string | undefined;
  password: string | undefined;
  database: string | undefined;
  /** Optional IAM-auth db user (token auth), where applicable. */
  iamUser: string | undefined;
}

/** AWS RDS PostgreSQL config (default port 5432). */
export function getRdsPostgresConfig(): SqlLiveConfig {
  return {
    host: env("CLOUDRIFT_LIVE_AWS_RDS_PG_HOST"),
    port: envInt("CLOUDRIFT_LIVE_AWS_RDS_PG_PORT", 5432),
    user: env("CLOUDRIFT_LIVE_AWS_RDS_PG_USER"),
    password: env("CLOUDRIFT_LIVE_AWS_RDS_PG_PASSWORD"),
    database: env("CLOUDRIFT_LIVE_AWS_RDS_PG_DATABASE"),
    iamUser: env("CLOUDRIFT_LIVE_AWS_RDS_PG_IAM_USER"),
  };
}

/** True when LIVE on, RDS Postgres password-auth vars present, "rds-postgres" allowlisted. */
export const RDS_POSTGRES_PRESENT =
  requireEnv([
    "CLOUDRIFT_LIVE_AWS_RDS_PG_HOST",
    "CLOUDRIFT_LIVE_AWS_RDS_PG_USER",
    "CLOUDRIFT_LIVE_AWS_RDS_PG_PASSWORD",
    "CLOUDRIFT_LIVE_AWS_RDS_PG_DATABASE",
  ]) && awsServiceEnabled("rds-postgres");

/** True when LIVE on, RDS Postgres IAM-auth vars present, "rds-postgres" allowlisted. */
export const RDS_POSTGRES_IAM_PRESENT =
  requireEnv([
    "CLOUDRIFT_LIVE_AWS_RDS_PG_HOST",
    "CLOUDRIFT_LIVE_AWS_RDS_PG_IAM_USER",
    "CLOUDRIFT_LIVE_AWS_RDS_PG_DATABASE",
    "CLOUDRIFT_LIVE_AWS_REGION",
  ]) && awsServiceEnabled("rds-postgres");

/** AWS RDS MySQL config (default port 3306). */
export function getRdsMysqlConfig(): SqlLiveConfig {
  return {
    host: env("CLOUDRIFT_LIVE_AWS_RDS_MYSQL_HOST"),
    port: envInt("CLOUDRIFT_LIVE_AWS_RDS_MYSQL_PORT", 3306),
    user: env("CLOUDRIFT_LIVE_AWS_RDS_MYSQL_USER"),
    password: env("CLOUDRIFT_LIVE_AWS_RDS_MYSQL_PASSWORD"),
    database: env("CLOUDRIFT_LIVE_AWS_RDS_MYSQL_DATABASE"),
    iamUser: env("CLOUDRIFT_LIVE_AWS_RDS_MYSQL_IAM_USER"),
  };
}

/** True when LIVE on, RDS MySQL password-auth vars present, "rds-mysql" allowlisted. */
export const RDS_MYSQL_PRESENT =
  requireEnv([
    "CLOUDRIFT_LIVE_AWS_RDS_MYSQL_HOST",
    "CLOUDRIFT_LIVE_AWS_RDS_MYSQL_USER",
    "CLOUDRIFT_LIVE_AWS_RDS_MYSQL_PASSWORD",
    "CLOUDRIFT_LIVE_AWS_RDS_MYSQL_DATABASE",
  ]) && awsServiceEnabled("rds-mysql");

/** True when LIVE on, RDS MySQL IAM-auth vars present, "rds-mysql" allowlisted. */
export const RDS_MYSQL_IAM_PRESENT =
  requireEnv([
    "CLOUDRIFT_LIVE_AWS_RDS_MYSQL_HOST",
    "CLOUDRIFT_LIVE_AWS_RDS_MYSQL_IAM_USER",
    "CLOUDRIFT_LIVE_AWS_RDS_MYSQL_DATABASE",
    "CLOUDRIFT_LIVE_AWS_REGION",
  ]) && awsServiceEnabled("rds-mysql");

/** AWS Redshift config (default port 5439). `iamUser` is always undefined. */
export function getRedshiftConfig(): SqlLiveConfig {
  return {
    host: env("CLOUDRIFT_LIVE_AWS_REDSHIFT_HOST"),
    port: envInt("CLOUDRIFT_LIVE_AWS_REDSHIFT_PORT", 5439),
    user: env("CLOUDRIFT_LIVE_AWS_REDSHIFT_USER"),
    password: env("CLOUDRIFT_LIVE_AWS_REDSHIFT_PASSWORD"),
    database: env("CLOUDRIFT_LIVE_AWS_REDSHIFT_DATABASE"),
    iamUser: undefined,
  };
}

/** True when LIVE on, all Redshift vars present, "redshift" allowlisted. */
export const REDSHIFT_PRESENT =
  requireEnv([
    "CLOUDRIFT_LIVE_AWS_REDSHIFT_HOST",
    "CLOUDRIFT_LIVE_AWS_REDSHIFT_USER",
    "CLOUDRIFT_LIVE_AWS_REDSHIFT_PASSWORD",
    "CLOUDRIFT_LIVE_AWS_REDSHIFT_DATABASE",
  ]) && awsServiceEnabled("redshift");

/**
 * Optional SQS FIFO / DLQ queue URLs (reuses AWS region + auth). Both are
 * optional because the FIFO lifecycle test may create its own queues; provide
 * pre-provisioned URLs to skip creation/cleanup.
 */
export interface SqsExtrasLiveConfig {
  fifoQueueUrl: string | undefined;
  dlqUrl: string | undefined;
}

export function getSqsExtrasConfig(): SqsExtrasLiveConfig {
  return {
    fifoQueueUrl: env("CLOUDRIFT_LIVE_AWS_FIFO_QUEUE_URL"),
    dlqUrl: env("CLOUDRIFT_LIVE_AWS_DLQ_URL"),
  };
}

/** Azure Service Bus session-enabled queue config (reuses the SB connection string). */
export interface AzureServiceBusSessionConfig {
  connectionString: string | undefined;
  sessionQueue: string | undefined;
}

export function getAzureServiceBusSessionConfig(): AzureServiceBusSessionConfig {
  return {
    connectionString: env("CLOUDRIFT_LIVE_AZURE_SERVICEBUS_CONNECTION_STRING"),
    sessionQueue: env("CLOUDRIFT_LIVE_AZURE_SB_SESSION_QUEUE"),
  };
}

/** True when LIVE on and both the SB connection string and session queue are present. */
export const AZURE_SB_SESSION_PRESENT = requireEnv([
  "CLOUDRIFT_LIVE_AZURE_SERVICEBUS_CONNECTION_STRING",
  "CLOUDRIFT_LIVE_AZURE_SB_SESSION_QUEUE",
]);
