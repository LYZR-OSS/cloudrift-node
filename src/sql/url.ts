/**
 * Shared URL/DSN helpers for SQL backends.
 *
 * Parse a SQLAlchemy-/driver-style connection URL into discrete components, and
 * re-emit a SQLAlchemy URL with proper percent-encoding. Used by the `fromUrl`
 * constructors and the `sqlalchemyUrl()` helpers. Ports `cloudrift-py`'s
 * `cloudrift/sql/_url.py`.
 */
import { CloudRiftError } from "../core/errors.js";

/** Parsed components of a SQL connection URL. */
export interface ParsedSqlUrl {
  host: string;
  port: number | undefined;
  user: string | undefined;
  password: string | undefined;
  database: string | undefined;
}

/**
 * Parse `[scheme://]user:pass@host:port/database` into its components.
 *
 * The scheme (e.g. `postgresql+psycopg`) is accepted but ignored — the caller
 * already knows the dialect. A bare `user:pass@host:port/db` (no scheme) is also
 * accepted. Percent-encoded credentials are decoded.
 */
export function parseSqlUrl(url: string, defaultPort?: number): ParsedSqlUrl {
  // Prepend `//` so the WHATWG URL parser treats a schemeless string as an
  // authority. Use a synthetic `cloudrift-sql:` scheme so parsing succeeds
  // regardless of the (ignored) real dialect scheme.
  const work = url.includes("://") ? url : `//${url}`;
  let parts: URL;
  try {
    // `new URL` requires an absolute URL; force a placeholder scheme onto the
    // authority form, but keep any user-supplied scheme when present.
    parts = work.startsWith("//") ? new URL(`cloudrift-sql:${work}`) : new URL(work);
  } catch {
    throw new CloudRiftError(`Could not parse host from SQL URL: ${JSON.stringify(url)}`);
  }
  if (!parts.hostname) {
    throw new CloudRiftError(`Could not parse host from SQL URL: ${JSON.stringify(url)}`);
  }
  const database = parts.pathname.replace(/^\/+/, "") || undefined;
  const port = parts.port !== "" ? Number(parts.port) : defaultPort;
  return {
    host: parts.hostname,
    port,
    user: parts.username !== "" ? decodeURIComponent(parts.username) : undefined,
    password: parts.password !== "" ? decodeURIComponent(parts.password) : undefined,
    database: database !== undefined ? decodeURIComponent(database) : undefined,
  };
}

/** Components for {@link buildSqlalchemyUrl}. */
export interface SqlalchemyUrlParts {
  host: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

/**
 * Build a percent-encoded SQLAlchemy URL, e.g.
 * `mysql+aiomysql://user:p%40ss@host:3306/db`. `database` may be omitted.
 */
export function buildSqlalchemyUrl(scheme: string, parts: SqlalchemyUrlParts): string {
  let auth = "";
  if (parts.user !== undefined) {
    auth = encodeURIComponent(parts.user);
    if (parts.password !== undefined) {
      auth += `:${encodeURIComponent(parts.password)}`;
    }
    auth += "@";
  }
  let netloc = `${auth}${parts.host}`;
  if (parts.port !== undefined) {
    netloc += `:${parts.port}`;
  }
  const path = parts.database ? `/${encodeURIComponent(parts.database)}` : "";
  return `${scheme}://${netloc}${path}`;
}
