/**
 * AWS S3 storage adapter.
 *
 * Mirrors `cloudrift-py/cloudrift/storage/s3.py`. The account-scoped
 * {@link AWSS3Client} owns one lazily-created `S3Client` (a single connection
 * pool); {@link AWSS3Backend} is a per-bucket view that shares it. Views from
 * `client.bucket(...)` have `ownsClient=false` so their `close()` is a no-op;
 * the factory-produced view owns the client and tears it down on `close()`.
 */

import { ObjectNotFoundError, StorageError, StoragePermissionError } from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { StorageBackend } from "./base.js";
import type { BinaryInput, ObjectMetadata } from "./base.js";

const PROVIDER = "s3";
const PKG = "@aws-sdk/client-s3";
const PRESIGNER_PKG = "@aws-sdk/s3-request-presigner";

interface AwsCredentialIdentityLike {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface S3ClientConfigLike {
  region?: string;
  endpoint?: string;
  credentials?: unknown;
  requestHandler?: unknown;
}

interface S3ClientLike {
  send(command: object): Promise<unknown>;
  destroy(): void;
}

interface GetObjectResponseLike {
  Body?: {
    transformToByteArray(): Promise<Uint8Array>;
  };
}

interface ListObjectsV2ResponseLike {
  Contents?: Array<{ Key?: string }>;
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}

interface HeadObjectResponseLike {
  ContentType?: string;
  ContentLength?: number;
  LastModified?: Date;
  ETag?: string;
  Metadata?: Record<string, string>;
}

/** Lazily-loaded `@aws-sdk/client-s3` module surface used by this adapter. */
interface S3Module {
  S3Client: new (config: S3ClientConfigLike) => S3ClientLike;
  PutObjectCommand: new (input: Record<string, unknown>) => object;
  GetObjectCommand: new (input: Record<string, unknown>) => object;
  HeadObjectCommand: new (input: Record<string, unknown>) => object;
  DeleteObjectCommand: new (input: Record<string, unknown>) => object;
  ListObjectsV2Command: new (input: Record<string, unknown>) => object;
  CopyObjectCommand: new (input: Record<string, unknown>) => object;
}

interface PresignerModule {
  getSignedUrl: (
    client: S3ClientLike,
    command: object,
    options: { expiresIn?: number },
  ) => Promise<string>;
}

/** Shared client config built by the factory constructors. */
interface S3ClientFactoryConfig {
  credentials?: AwsCredentialIdentityLike;
  region: string;
  endpointUrl?: string;
  profileName?: string;
  maxPoolConnections: number;
  connectTimeout: number;
  readTimeout: number;
}

export interface AwsClientOptions {
  endpointUrl?: string;
  maxPoolConnections?: number;
  connectTimeout?: number;
  readTimeout?: number;
}

export interface AwsAccessKeyOptions extends AwsClientOptions {
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken?: string;
  region?: string;
}

export interface AwsIamRoleOptions extends AwsClientOptions {
  region?: string;
}

export interface AwsProfileOptions extends AwsClientOptions {
  profileName: string;
  region?: string;
}

const DEFAULT_REGION = "us-east-1";
const DEFAULT_MAX_POOL = 50;
const DEFAULT_CONNECT_TIMEOUT = 10;
const DEFAULT_READ_TIMEOUT = 60;

function buildFactoryConfig(
  opts: AwsClientOptions,
  partial: Partial<S3ClientFactoryConfig>,
): S3ClientFactoryConfig {
  return {
    region: DEFAULT_REGION,
    maxPoolConnections: opts.maxPoolConnections ?? DEFAULT_MAX_POOL,
    connectTimeout: opts.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT,
    readTimeout: opts.readTimeout ?? DEFAULT_READ_TIMEOUT,
    endpointUrl: opts.endpointUrl,
    ...partial,
  };
}

/**
 * Account-scoped AWS S3 client. Owns one `S3Client`, lazily created on first
 * use, shared by every bucket view issued from it.
 */
export class AWSS3Client {
  private readonly config: S3ClientFactoryConfig;
  private clientPromise: Promise<S3ClientLike> | null = null;
  /** @internal Exposed for parity with the Python test surface (`client._client`). */
  _client: S3ClientLike | null = null;

  constructor(config: S3ClientFactoryConfig) {
    this.config = config;
  }

  static fromAccessKey(opts: AwsAccessKeyOptions): AWSS3Client {
    const credentials: AwsCredentialIdentityLike = {
      accessKeyId: opts.awsAccessKeyId,
      secretAccessKey: opts.awsSecretAccessKey,
      ...(opts.awsSessionToken ? { sessionToken: opts.awsSessionToken } : {}),
    };
    return new AWSS3Client(
      buildFactoryConfig(opts, {
        credentials,
        region: opts.region ?? DEFAULT_REGION,
      }),
    );
  }

  static fromIamRole(opts: AwsIamRoleOptions = {}): AWSS3Client {
    return new AWSS3Client(buildFactoryConfig(opts, { region: opts.region ?? DEFAULT_REGION }));
  }

  static fromProfile(opts: AwsProfileOptions): AWSS3Client {
    return new AWSS3Client(
      buildFactoryConfig(opts, {
        region: opts.region ?? DEFAULT_REGION,
        profileName: opts.profileName,
      }),
    );
  }

  /** Return a {@link StorageBackend} view bound to `name` (shares this pool). */
  bucket(name: string): AWSS3Backend {
    return new AWSS3Backend(name, this, false);
  }

  /**
   * Lazily create (and memoize) the underlying `S3Client`. Equivalent to the
   * Python `_ensure()` lock-guarded init.
   * @internal
   */
  async ensure(): Promise<S3ClientLike> {
    if (this.clientPromise === null) {
      this.clientPromise = this.create();
    }
    try {
      return await this.clientPromise;
    } catch (err) {
      this.clientPromise = null;
      this._client = null;
      throw err;
    }
  }

  private async create(): Promise<S3ClientLike> {
    const mod = await loadOptional<S3Module>(PKG, PROVIDER);
    const config: S3ClientConfigLike = {
      region: this.config.region,
      requestHandler: {
        connectionTimeout: this.config.connectTimeout * 1000,
        requestTimeout: this.config.readTimeout * 1000,
        httpsAgent: { maxSockets: this.config.maxPoolConnections },
      },
    };
    if (this.config.endpointUrl) {
      // Python s3.py only passes endpoint_url and relies on botocore's default
      // 'auto' addressing — it never forces path-style. Match that behavior.
      config.endpoint = this.config.endpointUrl;
    }
    if (this.config.credentials) {
      config.credentials = this.config.credentials;
    } else if (this.config.profileName) {
      const { fromIni } = await loadOptional<typeof import("@aws-sdk/credential-providers")>(
        "@aws-sdk/credential-providers",
        PROVIDER,
      );
      config.credentials = fromIni({ profile: this.config.profileName });
    }
    const client = new mod.S3Client(config);
    this._client = client;
    return client;
  }

  async close(): Promise<void> {
    if (this.clientPromise !== null) {
      const client = await this.clientPromise;
      client.destroy();
      this.clientPromise = null;
      this._client = null;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Per-bucket {@link StorageBackend} view over an {@link AWSS3Client}. */
export class AWSS3Backend extends StorageBackend {
  readonly bucket: string;
  /** @internal */
  readonly _client: AWSS3Client;
  private readonly ownsClient: boolean;
  private modPromise: Promise<S3Module> | null = null;

  constructor(bucket: string, client: AWSS3Client, ownsClient = false) {
    super();
    this.bucket = bucket;
    this._client = client;
    this.ownsClient = ownsClient;
  }

  static fromAccessKey(opts: AwsAccessKeyOptions & { bucket: string }): AWSS3Backend {
    return new AWSS3Backend(opts.bucket, AWSS3Client.fromAccessKey(opts), true);
  }

  static fromIamRole(opts: AwsIamRoleOptions & { bucket: string }): AWSS3Backend {
    return new AWSS3Backend(opts.bucket, AWSS3Client.fromIamRole(opts), true);
  }

  static fromProfile(opts: AwsProfileOptions & { bucket: string }): AWSS3Backend {
    return new AWSS3Backend(opts.bucket, AWSS3Client.fromProfile(opts), true);
  }

  private async mod(): Promise<S3Module> {
    if (this.modPromise === null) {
      this.modPromise = loadOptional<S3Module>(PKG, PROVIDER);
    }
    return this.modPromise;
  }

  async upload(key: string, data: BinaryInput, contentType?: string): Promise<string> {
    const [client, mod] = await Promise.all([this._client.ensure(), this.mod()]);
    try {
      await client.send(
        new mod.PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ...(contentType ? { ContentType: contentType } : {}),
        }),
      );
    } catch (err) {
      this.raise(err, key);
    }
    return key;
  }

  async download(key: string): Promise<Buffer> {
    const [client, mod] = await Promise.all([this._client.ensure(), this.mod()]);
    try {
      const response = (await client.send(
        new mod.GetObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as GetObjectResponseLike;
      const body = response.Body;
      if (!body) {
        return Buffer.alloc(0);
      }
      const bytes = await body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err) {
      this.raise(err, key);
    }
  }

  async delete(key: string): Promise<void> {
    const [client, mod] = await Promise.all([this._client.ensure(), this.mod()]);
    try {
      await client.send(new mod.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      this.raise(err, key);
    }
  }

  async exists(key: string): Promise<boolean> {
    const [client, mod] = await Promise.all([this._client.ensure(), this.mod()]);
    try {
      await client.send(new mod.HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) {
        return false;
      }
      this.raise(err, key);
    }
  }

  async list(prefix = ""): Promise<string[]> {
    const [client, mod] = await Promise.all([this._client.ensure(), this.mod()]);
    try {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const page = (await client.send(
          new mod.ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
          }),
        )) as ListObjectsV2ResponseLike;
        for (const obj of page.Contents ?? []) {
          if (obj.Key !== undefined) {
            keys.push(obj.Key);
          }
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);
      return keys;
    } catch (err) {
      this.raise(err, prefix);
    }
  }

  async *listIter(prefix = ""): AsyncIterable<string> {
    const [client, mod] = await Promise.all([this._client.ensure(), this.mod()]);
    let continuationToken: string | undefined;
    do {
      let page: ListObjectsV2ResponseLike;
      try {
        page = (await client.send(
          new mod.ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
          }),
        )) as ListObjectsV2ResponseLike;
      } catch (err) {
        this.raise(err, prefix);
      }
      for (const obj of page.Contents ?? []) {
        if (obj.Key !== undefined) {
          yield obj.Key;
        }
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  async presignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const [client, mod] = await Promise.all([this._client.ensure(), this.mod()]);
    try {
      const { getSignedUrl } = await loadOptional<PresignerModule>(PRESIGNER_PKG, PROVIDER);
      return await getSignedUrl(
        client,
        new mod.GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn },
      );
    } catch (err) {
      this.raise(err, key);
    }
  }

  async copy(srcKey: string, dstKey: string, dstBucket?: string): Promise<string> {
    const [client, mod] = await Promise.all([this._client.ensure(), this.mod()]);
    const targetBucket = dstBucket ?? this.bucket;
    try {
      await client.send(
        new mod.CopyObjectCommand({
          Bucket: targetBucket,
          CopySource: `${this.bucket}/${srcKey}`,
          Key: dstKey,
        }),
      );
    } catch (err) {
      this.raise(err, srcKey);
    }
    return dstKey;
  }

  async getMetadata(key: string): Promise<ObjectMetadata> {
    const [client, mod] = await Promise.all([this._client.ensure(), this.mod()]);
    try {
      const response = (await client.send(
        new mod.HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as HeadObjectResponseLike;
      return {
        contentType: response.ContentType,
        size: response.ContentLength ?? 0,
        lastModified: response.LastModified,
        etag: response.ETag,
        metadata: response.Metadata ?? {},
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
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return this.upload(key, Buffer.concat(chunks), contentType);
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      await this._client.close();
    }
  }

  private raise(exc: unknown, key: string): never {
    if (isNotFound(exc)) {
      throw new ObjectNotFoundError(`Object not found: ${key}`, { cause: exc });
    }
    if (isAccessDenied(exc)) {
      throw new StoragePermissionError(`Access denied for key: ${key}`, { cause: exc });
    }
    throw new StorageError(errorMessage(exc), { cause: exc });
  }
}

function errorCode(exc: unknown): string | undefined {
  if (typeof exc !== "object" || exc === null) {
    return undefined;
  }
  const e = exc as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (typeof e.name === "string") {
    return e.name;
  }
  if (typeof e.Code === "string") {
    return e.Code;
  }
  return undefined;
}

function statusCode(exc: unknown): number | undefined {
  if (typeof exc !== "object" || exc === null) {
    return undefined;
  }
  const meta = (exc as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  const status = meta?.httpStatusCode;
  return typeof status === "number" ? status : undefined;
}

function isNotFound(exc: unknown): boolean {
  const code = errorCode(exc);
  return code === "404" || code === "NoSuchKey" || code === "NotFound" || statusCode(exc) === 404;
}

function isAccessDenied(exc: unknown): boolean {
  const code = errorCode(exc);
  return code === "403" || code === "AccessDenied" || statusCode(exc) === 403;
}

function errorMessage(exc: unknown): string {
  if (exc instanceof Error) {
    return exc.message;
  }
  return String(exc);
}
