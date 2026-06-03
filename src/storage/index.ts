/**
 * Storage module public surface: factory functions plus re-exported backends,
 * clients, and types. Mirrors `cloudrift-py/cloudrift/storage/__init__.py`.
 */

import { normalizeChoice } from "../core/providers.js";
import { AWSS3Backend, AWSS3Client } from "./s3.js";
import { AzureBlobBackend, AzureBlobClient } from "./azureBlob.js";
import type { StorageBackend } from "./base.js";

export type StorageProvider = "s3" | "azure_blob";

const STORAGE_PROVIDERS = ["s3", "azure_blob"] as const satisfies readonly StorageProvider[];

export { StorageBackend } from "./base.js";
export type { BinaryInput, ObjectMetadata } from "./base.js";
export { AWSS3Backend, AWSS3Client } from "./s3.js";
export type {
  AwsClientOptions,
  AwsAccessKeyOptions,
  AwsIamRoleOptions,
  AwsProfileOptions,
} from "./s3.js";
export { AzureBlobBackend, AzureBlobClient } from "./azureBlob.js";

/**
 * Instantiate a single-bucket storage backend. The returned backend owns its
 * underlying SDK client — `await backend.close()` tears it down. Use
 * {@link getStorageClient} to share one connection pool across buckets.
 */
export async function getStorage(
  provider: StorageProvider | string,
  options: Record<string, unknown>,
): Promise<StorageBackend> {
  switch (normalizeChoice("storage provider", provider, STORAGE_PROVIDERS)) {
    case "s3":
      if ("awsAccessKeyId" in options) {
        return AWSS3Backend.fromAccessKey(
          options as unknown as Parameters<typeof AWSS3Backend.fromAccessKey>[0],
        );
      }
      if ("profileName" in options) {
        return AWSS3Backend.fromProfile(
          options as unknown as Parameters<typeof AWSS3Backend.fromProfile>[0],
        );
      }
      return AWSS3Backend.fromIamRole(
        options as unknown as Parameters<typeof AWSS3Backend.fromIamRole>[0],
      );
    case "azure_blob":
      if ("connectionString" in options) {
        return AzureBlobBackend.fromConnectionString(
          options as unknown as Parameters<typeof AzureBlobBackend.fromConnectionString>[0],
        );
      }
      if ("accountKey" in options) {
        return AzureBlobBackend.fromAccountKey(
          options as unknown as Parameters<typeof AzureBlobBackend.fromAccountKey>[0],
        );
      }
      if ("sasToken" in options) {
        return AzureBlobBackend.fromSasToken(
          options as unknown as Parameters<typeof AzureBlobBackend.fromSasToken>[0],
        );
      }
      if ("clientSecret" in options) {
        return AzureBlobBackend.fromServicePrincipal(
          options as unknown as Parameters<typeof AzureBlobBackend.fromServicePrincipal>[0],
        );
      }
      return AzureBlobBackend.fromManagedIdentity(
        options as Parameters<typeof AzureBlobBackend.fromManagedIdentity>[0],
      );
  }
}

/**
 * Instantiate an account-scoped storage client that can serve multiple
 * buckets/containers from a single connection pool. Get a {@link StorageBackend}
 * view via `client.bucket(name)` (S3) or `client.container(name)` (Azure).
 */
export async function getStorageClient(
  provider: StorageProvider | string,
  options: Record<string, unknown>,
): Promise<AWSS3Client | AzureBlobClient> {
  switch (normalizeChoice("storage provider", provider, STORAGE_PROVIDERS)) {
    case "s3":
      if ("awsAccessKeyId" in options) {
        return AWSS3Client.fromAccessKey(
          options as unknown as Parameters<typeof AWSS3Client.fromAccessKey>[0],
        );
      }
      if ("profileName" in options) {
        return AWSS3Client.fromProfile(
          options as unknown as Parameters<typeof AWSS3Client.fromProfile>[0],
        );
      }
      return AWSS3Client.fromIamRole(options as Parameters<typeof AWSS3Client.fromIamRole>[0]);
    case "azure_blob":
      if ("connectionString" in options) {
        return AzureBlobClient.fromConnectionString(
          options as unknown as Parameters<typeof AzureBlobClient.fromConnectionString>[0],
        );
      }
      if ("accountKey" in options) {
        return AzureBlobClient.fromAccountKey(
          options as unknown as Parameters<typeof AzureBlobClient.fromAccountKey>[0],
        );
      }
      if ("sasToken" in options) {
        return AzureBlobClient.fromSasToken(
          options as unknown as Parameters<typeof AzureBlobClient.fromSasToken>[0],
        );
      }
      if ("clientSecret" in options) {
        return AzureBlobClient.fromServicePrincipal(
          options as unknown as Parameters<typeof AzureBlobClient.fromServicePrincipal>[0],
        );
      }
      return AzureBlobClient.fromManagedIdentity(
        options as Parameters<typeof AzureBlobClient.fromManagedIdentity>[0],
      );
  }
}
