/**
 * Storage backend contract.
 *
 * Backends hold long-lived clients. Call `await backend.close()` (or use
 * `await using backend = ...`) to release sockets cleanly. Mirrors
 * `cloudrift-py/cloudrift/storage/base.py`.
 */

/** Accepted input shapes for an upload. */
export type BinaryInput = Buffer | Uint8Array | string;

/** Normalized object metadata returned by {@link StorageBackend.getMetadata}. */
export interface ObjectMetadata {
  contentType: string | undefined;
  size: number;
  lastModified: Date | undefined;
  etag: string | undefined;
  metadata: Record<string, string>;
}

/** Abstract base class for cloud object storage backends. */
export abstract class StorageBackend {
  /** Upload bytes to storage. Returns the object key. */
  abstract upload(key: string, data: BinaryInput, contentType?: string): Promise<string>;

  /** Download an object by key. Returns raw bytes. */
  abstract download(key: string): Promise<Buffer>;

  /** Delete an object by key. */
  abstract delete(key: string): Promise<void>;

  /** Return true if the object exists. */
  abstract exists(key: string): Promise<boolean>;

  /** List object keys, optionally filtered by prefix. */
  abstract list(prefix?: string): Promise<string[]>;

  /** Generate a presigned URL for the object. `expiresIn` is in seconds (default 3600). */
  abstract presignedUrl(key: string, expiresIn?: number): Promise<string>;

  /**
   * Copy an object. Defaults to a same-bucket copy. If `dstBucket` is provided,
   * copies across buckets/containers within the same storage account. Returns
   * the destination key.
   */
  abstract copy(srcKey: string, dstKey: string, dstBucket?: string): Promise<string>;

  /** Return object metadata. */
  abstract getMetadata(key: string): Promise<ObjectMetadata>;

  /** Upload from an async byte stream. Returns the object key. */
  abstract uploadStream(
    key: string,
    stream: AsyncIterable<Buffer | Uint8Array>,
    contentType?: string,
  ): Promise<string>;

  /** Move an object (copy + delete on the source). Returns the destination key. */
  async move(srcKey: string, dstKey: string, dstBucket?: string): Promise<string> {
    await this.copy(srcKey, dstKey, dstBucket);
    await this.delete(srcKey);
    return dstKey;
  }

  /** Yield object keys lazily. Default wraps {@link list}; override for true pagination. */
  async *listIter(prefix = ""): AsyncIterable<string> {
    for (const key of await this.list(prefix)) {
      yield key;
    }
  }

  /** Return true if the storage backend is reachable. */
  async healthCheck(): Promise<boolean> {
    try {
      await this.exists("__cloudrift_health__");
      return true;
    } catch {
      return false;
    }
  }

  /** Close the underlying client and release sockets. Default is a no-op. */
  async close(): Promise<void> {
    // no-op by default
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
