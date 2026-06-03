import { CloudRiftError } from "./errors.js";

/**
 * Dynamically import an optional peer dependency (a provider SDK).
 *
 * npm has no concept of "extras", so all provider SDKs are declared as optional
 * peer dependencies and imported lazily inside factory methods. A service that
 * only installs `@aws-sdk/client-s3` can use S3 storage without pulling in the
 * Azure SDKs.
 *
 * If the package is not installed, the underlying `import()` throws a
 * module-not-found error; we translate that into a `CloudRiftError` with a clear
 * install instruction naming both the missing package and the provider that
 * needs it. Any other import-time error is re-thrown unchanged.
 *
 * @param pkg      The npm package specifier to import (e.g. "@azure/storage-blob").
 * @param provider The cloudrift provider string requesting it (e.g. "azure_blob").
 * @returns        The imported module, typed as `T`.
 */
export async function loadOptional<T>(pkg: string, provider: string): Promise<T> {
  try {
    return (await import(pkg)) as T;
  } catch (err) {
    if (isModuleNotFound(err, pkg)) {
      throw new CloudRiftError(`install ${pkg} to use the ${provider} provider`, { cause: err });
    }
    throw err;
  }
}

const MODULE_NOT_FOUND_CODES = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
]);

function isModuleNotFound(err: unknown, pkg: string): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && MODULE_NOT_FOUND_CODES.has(code)) {
    return true;
  }
  // Some loaders surface a bare message without a code; match defensively on the
  // package name appearing in a "cannot find module" style message.
  const message = (err as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    /cannot find (module|package)/i.test(message) &&
    message.includes(pkg)
  );
}
