import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";

import {
  getStorage,
  getStorageClient,
  AWSS3Client,
  AWSS3Backend,
  AzureBlobClient,
  AzureBlobBackend,
} from "../src/storage/index.js";
import {
  ObjectNotFoundError,
  StoragePermissionError,
  StorageError,
  CloudRiftError,
} from "../src/core/errors.js";

/* ------------------------------------------------------------------ */
/* Presigner mock                                                      */
/* ------------------------------------------------------------------ */

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(
    async (
      _client: unknown,
      command: { input: { Bucket: string; Key: string } },
      options: { expiresIn?: number },
    ) =>
      `https://${command.input.Bucket}.s3.amazonaws.com/${command.input.Key}` +
      `?X-Amz-Expires=${options.expiresIn ?? 3600}`,
  ),
}));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const s3Mock = mockClient(S3Client);

function bodyFor(data: Buffer | string) {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return {
    transformToByteArray: async () => new Uint8Array(buf),
  };
}

function awsError(code: string, statusCode?: number): Error {
  const err = new Error(code) as Error & {
    name: string;
    $metadata?: { httpStatusCode?: number };
  };
  err.name = code;
  if (statusCode !== undefined) {
    err.$metadata = { httpStatusCode: statusCode };
  }
  return err;
}

const BUCKET = "test-bucket";

beforeEach(() => {
  s3Mock.reset();
});

afterEach(() => {
  s3Mock.reset();
});

async function makeBackend(): Promise<AWSS3Backend> {
  return AWSS3Backend.fromAccessKey({
    bucket: BUCKET,
    awsAccessKeyId: "test",
    awsSecretAccessKey: "test",
    region: "us-east-1",
  });
}

/* ------------------------------------------------------------------ */
/* S3 backend                                                          */
/* ------------------------------------------------------------------ */

describe("AWSS3Backend", () => {
  it("upload then download roundtrip", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(GetObjectCommand).resolves({ Body: bodyFor("hello world") as never });

    const backend = await makeBackend();
    const key = await backend.upload("hello.txt", Buffer.from("hello world"), "text/plain");
    expect(key).toBe("hello.txt");

    const data = await backend.download("hello.txt");
    expect(data.toString()).toBe("hello world");

    const putCall = s3Mock.commandCalls(PutObjectCommand)[0];
    expect(putCall.args[0].input.ContentType).toBe("text/plain");
  });

  it("delete sends DeleteObjectCommand", async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    const backend = await makeBackend();
    await backend.delete("gone.txt");
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });

  it("exists returns true when head succeeds", async () => {
    s3Mock.on(HeadObjectCommand).resolves({});
    const backend = await makeBackend();
    expect(await backend.exists("present.txt")).toBe(true);
  });

  it("exists returns false on 404", async () => {
    s3Mock.on(HeadObjectCommand).rejects(awsError("NotFound", 404));
    const backend = await makeBackend();
    expect(await backend.exists("missing.txt")).toBe(false);
  });

  it("list collects keys with prefix", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "logs/a.txt" }, { Key: "logs/b.txt" }],
      IsTruncated: false,
    });
    const backend = await makeBackend();
    const keys = await backend.list("logs/");
    expect(new Set(keys)).toEqual(new Set(["logs/a.txt", "logs/b.txt"]));
    expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input.Prefix).toBe("logs/");
  });

  it("listIter paginates across pages", async () => {
    s3Mock
      .on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: "iter/a.txt" }],
        IsTruncated: true,
        NextContinuationToken: "tok",
      })
      .resolvesOnce({
        Contents: [{ Key: "iter/b.txt" }],
        IsTruncated: false,
      });
    const backend = await makeBackend();
    const keys: string[] = [];
    for await (const k of backend.listIter("iter/")) {
      keys.push(k);
    }
    expect(keys).toEqual(["iter/a.txt", "iter/b.txt"]);
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(2);
  });

  it("getMetadata maps fields", async () => {
    const now = new Date();
    s3Mock.on(HeadObjectCommand).resolves({
      ContentType: "text/plain",
      ContentLength: 13,
      LastModified: now,
      ETag: '"abc"',
      Metadata: { foo: "bar" },
    });
    const backend = await makeBackend();
    const meta = await backend.getMetadata("meta.txt");
    expect(meta.contentType).toBe("text/plain");
    expect(meta.size).toBe(13);
    expect(meta.lastModified).toEqual(now);
    expect(meta.etag).toBe('"abc"');
    expect(meta.metadata).toEqual({ foo: "bar" });
  });

  it("copy sends CopyObjectCommand with CopySource", async () => {
    s3Mock.on(CopyObjectCommand).resolves({});
    const backend = await makeBackend();
    const dst = await backend.copy("src.txt", "dst.txt");
    expect(dst).toBe("dst.txt");
    const input = s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input;
    expect(input.CopySource).toBe(`${BUCKET}/src.txt`);
    expect(input.Bucket).toBe(BUCKET);
    expect(input.Key).toBe("dst.txt");
  });

  it("copy honors dstBucket", async () => {
    s3Mock.on(CopyObjectCommand).resolves({});
    const backend = await makeBackend();
    await backend.copy("src.txt", "dst.txt", "other-bucket");
    const input = s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input;
    expect(input.Bucket).toBe("other-bucket");
    expect(input.CopySource).toBe(`${BUCKET}/src.txt`);
  });

  it("move copies then deletes source", async () => {
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});
    const backend = await makeBackend();
    const dst = await backend.move("a.txt", "b.txt");
    expect(dst).toBe("b.txt");
    expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(1);
    const del = s3Mock.commandCalls(DeleteObjectCommand)[0];
    expect(del.args[0].input.Key).toBe("a.txt");
  });

  it("presignedUrl includes expiry", async () => {
    const backend = await makeBackend();
    const url = await backend.presignedUrl("file.txt", 120);
    expect(url).toContain("X-Amz-Expires=120");
    expect(url).toContain("file.txt");
  });

  it("uploadStream buffers chunks then uploads", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const backend = await makeBackend();

    async function* gen(): AsyncGenerator<Buffer> {
      yield Buffer.from("chunk1");
      yield Buffer.from("chunk2");
      yield Buffer.from("chunk3");
    }
    const key = await backend.uploadStream("streamed.txt", gen(), "text/plain");
    expect(key).toBe("streamed.txt");
    const body = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input.Body as Buffer;
    expect(Buffer.from(body).toString()).toBe("chunk1chunk2chunk3");
  });

  it("maps 404 to ObjectNotFoundError", async () => {
    s3Mock.on(GetObjectCommand).rejects(awsError("NoSuchKey", 404));
    const backend = await makeBackend();
    await expect(backend.download("nope.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("maps 403 to StoragePermissionError", async () => {
    s3Mock.on(GetObjectCommand).rejects(awsError("AccessDenied", 403));
    const backend = await makeBackend();
    await expect(backend.download("denied.txt")).rejects.toBeInstanceOf(
      StoragePermissionError,
    );
  });

  it("maps other errors to StorageError", async () => {
    s3Mock.on(PutObjectCommand).rejects(awsError("InternalError", 500));
    const backend = await makeBackend();
    await expect(backend.upload("k.txt", Buffer.from("x"))).rejects.toBeInstanceOf(
      StorageError,
    );
  });

  it("attaches the original error as cause", async () => {
    const orig = awsError("NoSuchKey", 404);
    s3Mock.on(GetObjectCommand).rejects(orig);
    const backend = await makeBackend();
    await expect(backend.download("k.txt")).rejects.toMatchObject({ cause: orig });
  });
});

/* ------------------------------------------------------------------ */
/* Multi-bucket sharing & ownership                                    */
/* ------------------------------------------------------------------ */

describe("AWSS3Client multi-bucket sharing", () => {
  it("getStorageClient returns an AWSS3Client", async () => {
    const client = await getStorageClient("s3", { region: "us-east-1" });
    expect(client).toBeInstanceOf(AWSS3Client);
  });

  it("views share one SDK client and a third view does not recreate it", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({});
    const client = (await getStorageClient("s3", {
      region: "us-east-1",
    })) as AWSS3Client;

    const viewA = client.bucket("bucket-a");
    const viewB = client.bucket("bucket-b");
    await viewA.upload("a.txt", Buffer.from("a"));
    await viewB.upload("b.txt", Buffer.from("b"));

    expect(client._client).not.toBeNull();
    const sdkClient = client._client;

    const viewC = client.bucket("bucket-a");
    await viewC.exists("a.txt");
    expect(client._client).toBe(sdkClient);
  });

  it("closing a shared view is a no-op", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({});
    const client = (await getStorageClient("s3", {
      region: "us-east-1",
    })) as AWSS3Client;

    const viewA = client.bucket("bucket-a");
    const viewB = client.bucket("bucket-b");
    await viewA.upload("a.txt", Buffer.from("a"));
    const sdkClient = client._client;
    expect(sdkClient).not.toBeNull();

    await viewA.close(); // no-op
    expect(client._client).toBe(sdkClient);
    await viewB.upload("b.txt", Buffer.from("b"));
    expect(await viewB.exists("b.txt")).toBe(true);
  });

  it("getStorage view owns its client and closes it", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const backend = (await getStorage("s3", {
      bucket: "owned",
      awsAccessKeyId: "test",
      awsSecretAccessKey: "test",
      region: "us-east-1",
    })) as AWSS3Backend;

    await backend.upload("k.txt", Buffer.from("data"));
    expect(backend._client._client).not.toBeNull();
    await backend.close();
    expect(backend._client._client).toBeNull();
  });

  it("cross-bucket copy uses target bucket", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(CopyObjectCommand).resolves({});
    const client = (await getStorageClient("s3", {
      region: "us-east-1",
    })) as AWSS3Client;
    const viewA = client.bucket("bucket-a");
    await viewA.upload("src.txt", Buffer.from("x"));
    const dst = await viewA.copy("src.txt", "copied.txt", "bucket-b");
    expect(dst).toBe("copied.txt");
    const input = s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input;
    expect(input.Bucket).toBe("bucket-b");
    expect(input.CopySource).toBe("bucket-a/src.txt");
  });
});

/* ------------------------------------------------------------------ */
/* Factory dispatch                                                    */
/* ------------------------------------------------------------------ */

describe("getStorage dispatch", () => {
  it("dispatches s3 access-key auth", async () => {
    const backend = await getStorage("s3", {
      bucket: "b",
      awsAccessKeyId: "x",
      awsSecretAccessKey: "y",
    });
    expect(backend).toBeInstanceOf(AWSS3Backend);
  });

  it("dispatches s3 iam-role auth (no creds)", async () => {
    const backend = await getStorage("s3", { bucket: "b", region: "us-west-2" });
    expect(backend).toBeInstanceOf(AWSS3Backend);
  });

  it("throws CloudRiftError for unknown provider", async () => {
    await expect(
      getStorage("gcs" as never, { bucket: "x" }),
    ).rejects.toBeInstanceOf(CloudRiftError);
    await expect(getStorage("gcs" as never, { bucket: "x" })).rejects.toThrow(
      /Unknown storage provider/,
    );
  });

  it("getStorageClient throws CloudRiftError for unknown provider", async () => {
    await expect(getStorageClient("gcs" as never, {})).rejects.toBeInstanceOf(
      CloudRiftError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Azure Blob — hand-rolled fake                                       */
/* ------------------------------------------------------------------ */

class FakeRestError extends Error {
  statusCode: number;
  code?: string;
  constructor(statusCode: number, code?: string) {
    super(`status ${statusCode}`);
    this.name = "RestError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

interface StoredBlob {
  data: Buffer;
  contentType?: string;
}

function makeFakeService() {
  const containers = new Map<string, Map<string, StoredBlob>>();
  const getContainer = (name: string) => {
    let c = containers.get(name);
    if (!c) {
      c = new Map();
      containers.set(name, c);
    }
    return c;
  };

  const failures: { op?: string; error?: Error } = {};

  const makeBlobClient = (containerName: string, key: string) => ({
    url: `https://acct.blob.core.windows.net/${containerName}/${key}`,
    async upload(
      body: Buffer,
      _len: number,
      options?: { blobHTTPHeaders?: { blobContentType?: string } },
    ) {
      if (failures.op === "upload" && failures.error) throw failures.error;
      getContainer(containerName).set(key, {
        data: Buffer.from(body),
        contentType: options?.blobHTTPHeaders?.blobContentType,
      });
    },
    async uploadStream(
      stream: Readable,
      _b?: number,
      _c?: number,
      options?: { blobHTTPHeaders?: { blobContentType?: string } },
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
      getContainer(containerName).set(key, {
        data: Buffer.concat(chunks),
        contentType: options?.blobHTTPHeaders?.blobContentType,
      });
    },
    async download() {
      if (failures.op === "download" && failures.error) throw failures.error;
      const blob = getContainer(containerName).get(key);
      if (!blob) throw new FakeRestError(404, "BlobNotFound");
      return { readableStreamBody: Readable.from([blob.data]) };
    },
    async delete() {
      if (!getContainer(containerName).has(key)) {
        throw new FakeRestError(404, "BlobNotFound");
      }
      getContainer(containerName).delete(key);
    },
    async exists() {
      return getContainer(containerName).has(key);
    },
    async getProperties() {
      const blob = getContainer(containerName).get(key);
      if (!blob) throw new FakeRestError(404, "BlobNotFound");
      return {
        contentType: blob.contentType,
        contentLength: blob.data.length,
        lastModified: new Date(0),
        etag: '"etag"',
        metadata: {},
      };
    },
    async beginCopyFromURL(copySource: string) {
      const path = new URL(copySource).pathname.replace(/^\//, "");
      const slash = path.indexOf("/");
      const srcContainer = slash === -1 ? containerName : path.slice(0, slash);
      const srcKey = slash === -1 ? path : path.slice(slash + 1);
      const src = getContainer(srcContainer).get(srcKey);
      if (!src) throw new FakeRestError(404, "BlobNotFound");
      getContainer(containerName).set(key, { ...src });
      return { pollUntilDone: async () => undefined };
    },
  });

  const service = {
    accountName: "acct",
    getContainerClient: (name: string) => ({
      getBlockBlobClient: (key: string) => makeBlobClient(name, key),
      async *listBlobsFlat(options?: { prefix?: string }) {
        if (failures.op === "list" && failures.error) throw failures.error;
        const prefix = options?.prefix ?? "";
        for (const k of getContainer(name).keys()) {
          if (k.startsWith(prefix)) yield { name: k };
        }
      },
    }),
    close: async () => undefined,
  };

  return { service, failures };
}

function makeAzureBackend(
  service: ReturnType<typeof makeFakeService>["service"],
  opts: { accountKey?: string } = {},
): AzureBlobBackend {
  const mod = {
    StorageSharedKeyCredential: class {
      constructor(
        public account: string,
        public key: string,
      ) {}
    },
    BlobSASPermissions: { parse: (p: string) => ({ perm: p }) },
    generateBlobSASQueryParameters: (
      values: { expiresOn: Date },
      _cred: unknown,
    ) => ({
      toString: () => `sig=fake&se=${values.expiresOn.toISOString()}`,
    }),
  } as unknown as ConstructorParameters<typeof AzureBlobClient>[0];

  const client = new AzureBlobClient(
    mod,
    service as never,
    opts.accountKey,
  );
  return new AzureBlobBackend("my-container", client, true);
}

describe("AzureBlobBackend (fake)", () => {
  it("upload then download roundtrip", async () => {
    const { service } = makeFakeService();
    const backend = makeAzureBackend(service);
    const key = await backend.upload("hello.txt", Buffer.from("hi azure"), "text/plain");
    expect(key).toBe("hello.txt");
    const data = await backend.download("hello.txt");
    expect(data.toString()).toBe("hi azure");
  });

  it("exists true/false", async () => {
    const { service } = makeFakeService();
    const backend = makeAzureBackend(service);
    expect(await backend.exists("missing.txt")).toBe(false);
    await backend.upload("present.txt", Buffer.from("x"));
    expect(await backend.exists("present.txt")).toBe(true);
  });

  it("delete removes the blob", async () => {
    const { service } = makeFakeService();
    const backend = makeAzureBackend(service);
    await backend.upload("d.txt", Buffer.from("x"));
    await backend.delete("d.txt");
    expect(await backend.exists("d.txt")).toBe(false);
  });

  it("list filters by prefix", async () => {
    const { service } = makeFakeService();
    const backend = makeAzureBackend(service);
    await backend.upload("logs/a.txt", Buffer.from("a"));
    await backend.upload("logs/b.txt", Buffer.from("b"));
    await backend.upload("data/c.txt", Buffer.from("c"));
    const keys = await backend.list("logs/");
    expect(new Set(keys)).toEqual(new Set(["logs/a.txt", "logs/b.txt"]));
  });

  it("listIter yields keys", async () => {
    const { service } = makeFakeService();
    const backend = makeAzureBackend(service);
    await backend.upload("x/a.txt", Buffer.from("a"));
    await backend.upload("x/b.txt", Buffer.from("b"));
    const keys: string[] = [];
    for await (const k of backend.listIter("x/")) keys.push(k);
    expect(new Set(keys)).toEqual(new Set(["x/a.txt", "x/b.txt"]));
  });

  it("getMetadata maps fields", async () => {
    const { service } = makeFakeService();
    const backend = makeAzureBackend(service);
    await backend.upload("m.txt", Buffer.from("hello"), "text/plain");
    const meta = await backend.getMetadata("m.txt");
    expect(meta.contentType).toBe("text/plain");
    expect(meta.size).toBe(5);
    expect(meta.etag).toBe('"etag"');
  });

  it("copy then download; move copies+deletes", async () => {
    const { service } = makeFakeService();
    const backend = makeAzureBackend(service);
    await backend.upload("src.txt", Buffer.from("source"));
    const dst = await backend.copy("src.txt", "dst.txt");
    expect(dst).toBe("dst.txt");
    expect((await backend.download("dst.txt")).toString()).toBe("source");
    expect(await backend.exists("src.txt")).toBe(true);

    const moved = await backend.move("src.txt", "moved.txt");
    expect(moved).toBe("moved.txt");
    expect(await backend.exists("src.txt")).toBe(false);
    expect((await backend.download("moved.txt")).toString()).toBe("source");
  });

  it("uploadStream streams chunks", async () => {
    const { service } = makeFakeService();
    const backend = makeAzureBackend(service);
    async function* gen(): AsyncGenerator<Buffer> {
      yield Buffer.from("a");
      yield Buffer.from("b");
      yield Buffer.from("c");
    }
    const key = await backend.uploadStream("s.txt", gen());
    expect(key).toBe("s.txt");
    expect((await backend.download("s.txt")).toString()).toBe("abc");
  });

  it("presignedUrl requires accountKey", async () => {
    const { service } = makeFakeService();
    const backend = makeAzureBackend(service); // no accountKey
    await expect(backend.presignedUrl("k.txt")).rejects.toBeInstanceOf(StorageError);
  });

  it("presignedUrl includes expiry when accountKey present", async () => {
    const { service } = makeFakeService();
    const backend = makeAzureBackend(service, { accountKey: "a-key" });
    const url = await backend.presignedUrl("k.txt", 200);
    expect(url).toContain("my-container/k.txt");
    expect(url).toContain("se=");
  });

  it("maps 404 to ObjectNotFoundError", async () => {
    const { service } = makeFakeService();
    const backend = makeAzureBackend(service);
    await expect(backend.download("nope.txt")).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  it("maps 403 to StoragePermissionError", async () => {
    const { service, failures } = makeFakeService();
    failures.op = "download";
    failures.error = new FakeRestError(403);
    const backend = makeAzureBackend(service);
    await expect(backend.download("k.txt")).rejects.toBeInstanceOf(
      StoragePermissionError,
    );
  });

  it("maps other errors to StorageError", async () => {
    const { service, failures } = makeFakeService();
    failures.op = "upload";
    failures.error = new FakeRestError(500);
    const backend = makeAzureBackend(service);
    await expect(backend.upload("k.txt", Buffer.from("x"))).rejects.toBeInstanceOf(
      StorageError,
    );
  });
});
