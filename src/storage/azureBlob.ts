/**
 * Azure Blob Storage adapter.
 *
 * Mirrors `cloudrift-py/cloudrift/storage/azure_blob.py`. The account-scoped
 * {@link AzureBlobClient} owns one `BlobServiceClient`; {@link AzureBlobBackend}
 * is a per-container view that shares it. Views from `client.container(...)`
 * have `ownsClient=false` (no-op `close()`); the factory-produced view owns the
 * client and tears it down on `close()`.
 *
 * `uploadStream` uses true streaming via `BlockBlobClient.uploadStream` fed by
 * `Readable.from`. `presignedUrl` requires account-key auth.
 */

import { Readable } from "node:stream";

import { ObjectNotFoundError, StorageError, StoragePermissionError } from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { StorageBackend } from "./base.js";
import type { BinaryInput, ObjectMetadata } from "./base.js";

const PROVIDER = "azure_blob";
const PKG = "@azure/storage-blob";
const IDENTITY_PKG = "@azure/identity";

/* ------------------------------------------------------------------ */
/* Minimal structural views of the Azure SDK surface this adapter uses. */
/* ------------------------------------------------------------------ */

interface AzureBlockBlobClient {
  url: string;
  upload(
    body: BinaryInput,
    contentLength: number,
    options?: { blobHTTPHeaders?: { blobContentType?: string } },
  ): Promise<unknown>;
  download(offset?: number): Promise<{ readableStreamBody?: NodeJS.ReadableStream }>;
  delete(): Promise<unknown>;
  exists(): Promise<boolean>;
  uploadStream(
    stream: Readable,
    bufferSize?: number,
    maxConcurrency?: number,
    options?: { blobHTTPHeaders?: { blobContentType?: string } },
  ): Promise<unknown>;
  getProperties(): Promise<{
    contentType?: string;
    contentLength?: number;
    lastModified?: Date;
    etag?: string;
    metadata?: Record<string, string>;
  }>;
  beginCopyFromURL(copySource: string): Promise<{ pollUntilDone(): Promise<unknown> }>;
}

interface AzureContainerClient {
  getBlockBlobClient(blobName: string): AzureBlockBlobClient;
  listBlobsFlat(options?: { prefix?: string }): AsyncIterable<{ name: string }>;
}

interface AzureServiceClient {
  accountName: string;
  getContainerClient(name: string): AzureContainerClient;
  close?(): Promise<void>;
}

interface AzureClosableCredential {
  close?(): Promise<void>;
}

interface AzureBlobModule {
  BlobServiceClient: {
    fromConnectionString(connectionString: string): AzureServiceClient;
    new (url: string, credential?: unknown): AzureServiceClient;
  };
  StorageSharedKeyCredential: new (accountName: string, accountKey: string) => unknown;
  BlobSASPermissions: { parse(permissions: string): unknown };
  generateBlobSASQueryParameters: (
    values: {
      containerName: string;
      blobName: string;
      permissions: unknown;
      expiresOn: Date;
    },
    credential: unknown,
  ) => { toString(): string };
}

/* ------------------------------------------------------------------ */

/** Account-scoped Azure Blob client. */
export class AzureBlobClient {
  /** @internal */
  readonly _service: AzureServiceClient;
  /** @internal */
  readonly _accountKey: string | undefined;
  /** @internal */
  readonly _credential: AzureClosableCredential | undefined;
  /** @internal */
  readonly _mod: AzureBlobModule;

  constructor(
    mod: AzureBlobModule,
    service: AzureServiceClient,
    accountKey?: string,
    credential?: AzureClosableCredential,
  ) {
    this._mod = mod;
    this._service = service;
    this._accountKey = accountKey;
    this._credential = credential;
  }

  static async fromConnectionString(opts: { connectionString: string }): Promise<AzureBlobClient> {
    const mod = await loadOptional<AzureBlobModule>(PKG, PROVIDER);
    const accountKey = parseConnStringField(opts.connectionString, "AccountKey");
    const service = mod.BlobServiceClient.fromConnectionString(opts.connectionString);
    return new AzureBlobClient(mod, service, accountKey ?? undefined);
  }

  static async fromAccountKey(opts: {
    accountUrl: string;
    accountKey: string;
  }): Promise<AzureBlobClient> {
    const mod = await loadOptional<AzureBlobModule>(PKG, PROVIDER);
    const credential = new mod.StorageSharedKeyCredential(
      accountNameFromUrl(opts.accountUrl),
      opts.accountKey,
    );
    const service = new mod.BlobServiceClient(opts.accountUrl, credential);
    return new AzureBlobClient(mod, service, opts.accountKey);
  }

  static async fromSasToken(opts: {
    accountUrl: string;
    sasToken: string;
  }): Promise<AzureBlobClient> {
    const mod = await loadOptional<AzureBlobModule>(PKG, PROVIDER);
    const sas = opts.sasToken.startsWith("?") ? opts.sasToken : `?${opts.sasToken}`;
    const service = new mod.BlobServiceClient(`${opts.accountUrl}${sas}`);
    return new AzureBlobClient(mod, service);
  }

  static async fromManagedIdentity(opts: {
    accountUrl: string;
    clientId?: string;
  }): Promise<AzureBlobClient> {
    const mod = await loadOptional<AzureBlobModule>(PKG, PROVIDER);
    const { ManagedIdentityCredential } = await loadOptional<{
      ManagedIdentityCredential: new (options?: { clientId?: string }) => AzureClosableCredential;
    }>(IDENTITY_PKG, PROVIDER);
    const credential = opts.clientId
      ? new ManagedIdentityCredential({ clientId: opts.clientId })
      : new ManagedIdentityCredential();
    const service = new mod.BlobServiceClient(opts.accountUrl, credential);
    return new AzureBlobClient(mod, service, undefined, credential);
  }

  static async fromServicePrincipal(opts: {
    accountUrl: string;
    tenantId: string;
    clientId: string;
    clientSecret: string;
  }): Promise<AzureBlobClient> {
    const mod = await loadOptional<AzureBlobModule>(PKG, PROVIDER);
    const { ClientSecretCredential } = await loadOptional<{
      ClientSecretCredential: new (
        tenantId: string,
        clientId: string,
        clientSecret: string,
      ) => AzureClosableCredential;
    }>(IDENTITY_PKG, PROVIDER);
    const credential = new ClientSecretCredential(opts.tenantId, opts.clientId, opts.clientSecret);
    const service = new mod.BlobServiceClient(opts.accountUrl, credential);
    return new AzureBlobClient(mod, service, undefined, credential);
  }

  /** Return a {@link StorageBackend} view bound to `name` (shares this connection). */
  container(name: string): AzureBlobBackend {
    return new AzureBlobBackend(name, this, false);
  }

  async close(): Promise<void> {
    if (this._service.close) {
      await this._service.close();
    }
    if (this._credential?.close) {
      await this._credential.close();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Per-container {@link StorageBackend} view over an {@link AzureBlobClient}. */
export class AzureBlobBackend extends StorageBackend {
  readonly container: string;
  /** @internal */
  readonly _client: AzureBlobClient;
  private readonly ownsClient: boolean;

  constructor(container: string, client: AzureBlobClient, ownsClient = false) {
    super();
    this.container = container;
    this._client = client;
    this.ownsClient = ownsClient;
  }

  static async fromConnectionString(opts: {
    connectionString: string;
    container: string;
  }): Promise<AzureBlobBackend> {
    const client = await AzureBlobClient.fromConnectionString(opts);
    return new AzureBlobBackend(opts.container, client, true);
  }

  static async fromAccountKey(opts: {
    accountUrl: string;
    accountKey: string;
    container: string;
  }): Promise<AzureBlobBackend> {
    const client = await AzureBlobClient.fromAccountKey(opts);
    return new AzureBlobBackend(opts.container, client, true);
  }

  static async fromSasToken(opts: {
    accountUrl: string;
    sasToken: string;
    container: string;
  }): Promise<AzureBlobBackend> {
    const client = await AzureBlobClient.fromSasToken(opts);
    return new AzureBlobBackend(opts.container, client, true);
  }

  static async fromManagedIdentity(opts: {
    accountUrl: string;
    container: string;
    clientId?: string;
  }): Promise<AzureBlobBackend> {
    const client = await AzureBlobClient.fromManagedIdentity(opts);
    return new AzureBlobBackend(opts.container, client, true);
  }

  static async fromServicePrincipal(opts: {
    accountUrl: string;
    tenantId: string;
    clientId: string;
    clientSecret: string;
    container: string;
  }): Promise<AzureBlobBackend> {
    const client = await AzureBlobClient.fromServicePrincipal(opts);
    return new AzureBlobBackend(opts.container, client, true);
  }

  private get service(): AzureServiceClient {
    return this._client._service;
  }

  private blob(key: string): AzureBlockBlobClient {
    return this.service.getContainerClient(this.container).getBlockBlobClient(key);
  }

  async upload(key: string, data: BinaryInput, contentType?: string): Promise<string> {
    const buffer = toBuffer(data);
    try {
      await this.blob(key).upload(
        buffer,
        buffer.length,
        contentType ? { blobHTTPHeaders: { blobContentType: contentType } } : undefined,
      );
    } catch (err) {
      this.raise(err, key);
    }
    return key;
  }

  async download(key: string): Promise<Buffer> {
    try {
      const response = await this.blob(key).download();
      const body = response.readableStreamBody;
      if (!body) {
        return Buffer.alloc(0);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      this.raise(err, key);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.blob(key).delete();
    } catch (err) {
      this.raise(err, key);
    }
  }

  async exists(key: string): Promise<boolean> {
    // Mirrors Python azure_blob.py exists(): no try/except, so any non-404
    // error propagates as the raw SDK error (the SDK returns false for missing
    // blobs). Do not route through this.raise() here.
    return await this.blob(key).exists();
  }

  async list(prefix = ""): Promise<string[]> {
    const container = this.service.getContainerClient(this.container);
    try {
      const keys: string[] = [];
      for await (const blob of container.listBlobsFlat(prefix ? { prefix } : undefined)) {
        keys.push(blob.name);
      }
      return keys;
    } catch (err) {
      this.raise(err, prefix);
    }
  }

  async *listIter(prefix = ""): AsyncIterable<string> {
    const container = this.service.getContainerClient(this.container);
    let iter: AsyncIterable<{ name: string }>;
    try {
      iter = container.listBlobsFlat(prefix ? { prefix } : undefined);
    } catch (err) {
      this.raise(err, prefix);
    }
    const iterator = iter[Symbol.asyncIterator]();
    for (;;) {
      let result: IteratorResult<{ name: string }>;
      try {
        result = await iterator.next();
      } catch (err) {
        this.raise(err, prefix);
      }
      if (result.done) {
        break;
      }
      yield result.value.name;
    }
  }

  async presignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const accountKey = this._client._accountKey;
    if (!accountKey) {
      throw new StorageError(
        "presignedUrl requires account_key authentication. " +
          "Use fromConnectionString or fromAccountKey.",
      );
    }
    const mod = this._client._mod;
    try {
      const credential = new mod.StorageSharedKeyCredential(this.service.accountName, accountKey);
      const sas = mod
        .generateBlobSASQueryParameters(
          {
            containerName: this.container,
            blobName: key,
            permissions: mod.BlobSASPermissions.parse("r"),
            expiresOn: new Date(Date.now() + expiresIn * 1000),
          },
          credential,
        )
        .toString();
      return (
        `https://${this.service.accountName}.blob.core.windows.net/` +
        `${this.container}/${key}?${sas}`
      );
    } catch (err) {
      this.raise(err, key);
    }
  }

  async copy(srcKey: string, dstKey: string, dstBucket?: string): Promise<string> {
    const targetContainer = dstBucket ?? this.container;
    const srcBlob = this.blob(srcKey);
    const dstBlob = this.service.getContainerClient(targetContainer).getBlockBlobClient(dstKey);
    try {
      const poller = await dstBlob.beginCopyFromURL(srcBlob.url);
      await poller.pollUntilDone();
    } catch (err) {
      this.raise(err, srcKey);
    }
    return dstKey;
  }

  async getMetadata(key: string): Promise<ObjectMetadata> {
    try {
      const props = await this.blob(key).getProperties();
      return {
        contentType: props.contentType,
        size: props.contentLength ?? 0,
        lastModified: props.lastModified,
        etag: props.etag,
        metadata: props.metadata ?? {},
      };
    } catch (err) {
      this.raise(err, key);
    }
  }

  async uploadStream(
    key: string,
    stream: AsyncIterable<Buffer | Uint8Array>,
    contentType?: string,
  ): Promise<string> {
    try {
      await this.blob(key).uploadStream(
        Readable.from(stream),
        undefined,
        undefined,
        contentType ? { blobHTTPHeaders: { blobContentType: contentType } } : undefined,
      );
    } catch (err) {
      this.raise(err, key);
    }
    return key;
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      await this._client.close();
    }
  }

  private raise(exc: unknown, key: string): never {
    const status = restErrorStatus(exc);
    if (status === 404 || errorCode(exc) === "BlobNotFound") {
      throw new ObjectNotFoundError(`Object not found: ${key}`, { cause: exc });
    }
    if (status === 403) {
      throw new StoragePermissionError(`Access denied for key: ${key}`, { cause: exc });
    }
    throw new StorageError(errorMessage(exc), { cause: exc });
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function toBuffer(data: BinaryInput): Buffer {
  if (typeof data === "string") {
    return Buffer.from(data);
  }
  return Buffer.from(data);
}

function restErrorStatus(exc: unknown): number | undefined {
  if (typeof exc !== "object" || exc === null) {
    return undefined;
  }
  const status = (exc as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}

function errorCode(exc: unknown): string | undefined {
  if (typeof exc !== "object" || exc === null) {
    return undefined;
  }
  const code = (exc as { code?: unknown; details?: { errorCode?: unknown } }).code;
  if (typeof code === "string") {
    return code;
  }
  const details = (exc as { details?: { errorCode?: unknown } }).details;
  if (details && typeof details.errorCode === "string") {
    return details.errorCode;
  }
  return undefined;
}

function errorMessage(exc: unknown): string {
  if (exc instanceof Error) {
    return exc.message;
  }
  return String(exc);
}

function parseConnStringField(connString: string, field: string): string | null {
  for (const part of connString.split(";")) {
    if (part.startsWith(`${field}=`)) {
      return part.slice(field.length + 1);
    }
  }
  return null;
}

function accountNameFromUrl(accountUrl: string): string {
  try {
    const host = new URL(accountUrl).hostname;
    return host.split(".")[0] ?? "";
  } catch {
    return "";
  }
}
