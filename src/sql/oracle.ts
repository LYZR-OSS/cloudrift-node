/**
 * Oracle Database backed by the `oracledb` driver (thin mode). Ports
 * `cloudrift-py`'s `cloudrift/sql/oracle.py`.
 *
 * The Python driver is synchronous and offloads `connect()` to a worker thread;
 * the Node `oracledb` driver exposes a native-async `getConnection`, so no
 * thread offload is needed (parity preserved at the behavior level).
 */
import { SQLConnectionError } from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { SQLBackend, type SqlConnection } from "./base.js";

const PROVIDER = "oracle";
const ORACLE_PACKAGE = "oracledb";

/** Shape of the lazily-imported `oracledb` module (just what we touch). */
interface OracleModule {
  getConnection(config: Record<string, unknown>): Promise<OracleConnection>;
}
interface OracleConnection {
  close(): Promise<void>;
}

export interface OracleCredentialsOptions {
  host: string;
  username: string;
  password: string;
  port?: number;
  serviceName?: string;
  sid?: string;
  protocol?: string;
  walletPath?: string;
  walletPassword?: string;
  connectionKwargs?: Record<string, unknown>;
}

interface OracleInit {
  host: string;
  port: number;
  username: string;
  password: string;
  serviceName?: string;
  sid?: string;
  protocol: string;
  walletPath?: string;
  walletPassword?: string;
  connectionKwargs: Record<string, unknown>;
}

export class OracleSQLBackend extends SQLBackend {
  override readonly dialect: string = "oracle";

  private readonly init: OracleInit;

  private constructor(init: OracleInit) {
    super();
    this.init = init;
  }

  /**
   * Authenticate with username/password. Provide exactly one of `serviceName`
   * or `sid`. `walletPath` enables thin-mode mTLS wallets (TCPS).
   */
  static fromCredentials(opts: OracleCredentialsOptions): OracleSQLBackend {
    return new OracleSQLBackend({
      host: opts.host,
      port: opts.port ?? 1521,
      username: opts.username,
      password: opts.password,
      serviceName: opts.serviceName,
      sid: opts.sid,
      protocol: opts.protocol ?? "tcp",
      walletPath: opts.walletPath,
      walletPassword: opts.walletPassword,
      connectionKwargs: opts.connectionKwargs ?? {},
    });
  }

  /**
   * Build the connect string. Service-name uses Easy Connect
   * (`protocol://host:port/service`); SID has no Easy Connect form, so it must
   * be a full TNS descriptor (mirrors Python's `oracledb.ConnectParams(sid=...)`).
   */
  private buildConnectString(): string {
    const { protocol, host, port, sid, serviceName } = this.init;
    if (sid !== undefined) {
      return (
        `(DESCRIPTION=(ADDRESS=(PROTOCOL=${protocol})(HOST=${host})(PORT=${port}))` +
        `(CONNECT_DATA=(SID=${sid})))`
      );
    }
    const base = `${protocol}://${host}:${port}`;
    if (serviceName !== undefined) {
      return `${base}/${serviceName}`;
    }
    return base;
  }

  override async connect(timeout?: number): Promise<SqlConnection> {
    const oracledb = await loadOptional<OracleModule>(ORACLE_PACKAGE, PROVIDER);

    const config: Record<string, unknown> = {
      user: this.init.username,
      password: this.init.password,
      connectString: this.buildConnectString(),
      ...this.init.connectionKwargs,
    };
    if (this.init.walletPath !== undefined) {
      config.walletLocation = this.init.walletPath;
      config.configDir = this.init.walletPath;
      if (this.init.walletPassword !== undefined) {
        config.walletPassword = this.init.walletPassword;
      }
    }

    try {
      const connectPromise = oracledb.getConnection(config);
      if (timeout !== undefined) {
        return await withTimeout(connectPromise, timeout);
      }
      return await connectPromise;
    } catch (err) {
      if (err instanceof SQLConnectionError) {
        throw err;
      }
      throw new SQLConnectionError(`Failed to connect to Oracle: ${errorMessage(err)}`, {
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
        new SQLConnectionError(`Timed out connecting to Oracle after ${timeoutSeconds} seconds.`),
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
