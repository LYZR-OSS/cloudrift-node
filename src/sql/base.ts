/**
 * Abstract base for relational-SQL connection backends.
 *
 * cloudrift's SQL layer abstracts **connection construction and cloud
 * authentication**, not query execution. Unlike a Mongo/Redis backend, there is
 * no single wire protocol across SQL engines, so this layer does not wrap
 * queries — it hands the caller a fully-authenticated **native driver
 * connection** and the caller uses that driver's own API.
 *
 * Why `connect()` returns a *fresh* connection each call:
 *   - For static-credential engines (plain user/password) the caller typically
 *     opens one connection and reuses it.
 *   - For token-auth engines (Azure Entra / AAD, AWS RDS IAM) the access token
 *     is short-lived, so a fresh token must be acquired per connection. Calling
 *     `connect()` again transparently mints a new token. This makes the
 *     "open a new connection per query" pattern safe and is why token freshness
 *     is the backend's responsibility, not the caller's.
 *
 * Ports `cloudrift-py`'s `cloudrift/sql/base.py`. Python's `async with
 * backend.acquire()` becomes {@link SQLBackend.withConnection}, since TypeScript
 * has no `async with`. `close()` plus `Symbol.asyncDispose` provide the
 * async-context-manager equivalent for the backend itself.
 */

/** A native driver connection — its concrete type depends on the dialect. */
export type SqlConnection = unknown;

/**
 * Minimal shape of a native connection's teardown method. Different drivers
 * expose teardown under different names: `pg.Client` / `mysql2/promise` use
 * `end()`, others use `close()`, and some sockets use `destroy()`.
 */
interface ClosableConnection {
  close?: () => void | Promise<void>;
  end?: () => void | Promise<void>;
  destroy?: () => void | Promise<void>;
}

export abstract class SQLBackend {
  /** Engine family identifier — see subclasses for the dialect mapping. */
  readonly dialect: string = "sql";

  /**
   * Open and return a fresh, authenticated native connection.
   *
   * @param timeout Optional connection timeout in seconds, applied via the
   *   native driver's own timeout mechanism.
   * @throws SQLConnectionError The connection could not be established.
   * @throws SQLAuthError A required credential/token could not be acquired.
   */
  abstract connect(timeout?: number): Promise<SqlConnection>;

  /**
   * Lease a connection for the duration of the callback and close it afterward.
   *
   * Uniform across backends: when the backend has pooling enabled (see the
   * Postgres/MSSQL `pool` options) a pooled connection is leased and returned to
   * the pool on exit; otherwise a fresh connection is opened and closed on exit.
   * Use this instead of `connect()` when you want the connection lifecycle
   * managed for you.
   */
  async withConnection<T>(cb: (conn: SqlConnection) => Promise<T>, timeout?: number): Promise<T> {
    const conn = await this.connect(timeout);
    try {
      return await cb(conn);
    } finally {
      await SQLBackend.closeConnection(conn);
    }
  }

  /**
   * Close a native connection, awaiting an async teardown if present.
   *
   * Drivers disagree on the teardown method name: `pg.Client` and
   * `mysql2/promise` expose `end()` (no public `close()`), while others expose
   * `close()` or `destroy()`. Mirrors Python's `_aclose_connection`, which
   * resolves `close` dynamically — here we prefer `close()`, then `end()`, then
   * `destroy()`, awaiting whichever exists.
   */
  protected static async closeConnection(conn: SqlConnection): Promise<void> {
    const c = conn as ClosableConnection | null | undefined;
    const teardown = c?.close ?? c?.end ?? c?.destroy;
    if (typeof teardown !== "function") {
      return;
    }
    await teardown.call(conn);
  }

  /**
   * Release backend-held resources (credential clients, token caches, pools).
   *
   * Does NOT close connections handed out by {@link connect} — the caller owns
   * those. Default is a no-op; backends that hold a pool override this.
   */
  async close(): Promise<void> {
    // no-op by default
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
