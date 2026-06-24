/**
 * Low-level TLS certificate-pinning helper for SQL Server.
 *
 * Ports `cloudrift-py`'s `cloudrift/sql/_mssql_tls.py`, which performs a minimal
 * TDS PRELOGIN exchange and a hand-driven `ssl.MemoryBIO` handshake to extract
 * and fingerprint the server certificate.
 *
 * v1 divergence: the npm `mssql`/`tedious` driver accepts the AAD access token
 * directly and exposes its own TLS trust options, and Node has no MemoryBIO TLS
 * primitive equivalent to Python's, so the bespoke TDS-PRELOGIN fingerprinting
 * path is not reimplemented. Passing `serverCertificate` therefore throws a
 * clear `SQLConnectionError`. Recorded in docs/PARITY.md.
 */
import { SQLConnectionError } from "../core/errors.js";

/**
 * Validate that the live server certificate's SHA-256 fingerprint matches the
 * caller-supplied pinned PEM.
 *
 * Not implemented in the TypeScript port — see the module docstring. Always
 * throws {@link SQLConnectionError}.
 */
export async function validatePinnedCertificate(
  _host: string,
  _port: number,
  _pinnedPem: string,
): Promise<void> {
  throw new SQLConnectionError(
    "Certificate pinning (serverCertificate) is not implemented in the TypeScript SQL " +
      "backend. Configure trust via the mssql driver's encrypt/trustServerCertificate " +
      "options in connectionKwargs instead.",
  );
}
