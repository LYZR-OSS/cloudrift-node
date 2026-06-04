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
 *                                          (Secrets Manager). Example:
 *                                          CLOUDRIFT_LIVE_AWS_SERVICES="s3,sqs"
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
 * "s3", "sqs", "sns", and "secrets" (AWS Secrets Manager).
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
