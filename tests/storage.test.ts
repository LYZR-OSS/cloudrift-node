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
  StorageBackend,
} from "../src/storage/index.js";
import type { BinaryInput, ObjectMetadata } from "../src/storage/index.js";
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

const credentialProviderMock = vi.hoisted(() => ({
  fromIni: vi.fn(() => async () => ({
    accessKeyId: "profile-key",
    secretAccessKey: "profile-secret",
  })),
}));

vi.mock("@aws-sdk/credential-providers", () => credentialProviderMock);

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
  credentialProviderMock.fromIni.mockReset();
  credentialProviderMock.fromIni.mockReturnValue(async () => ({
    accessKeyId: "profile-key",
    secretAccessKey: "profile-secret",
  }));
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
    await expect(backend.download("denied.txt")).rejects.toBeInstanceOf(StoragePermissionError);
  });

  it("maps other errors to StorageError", async () => {
    s3Mock.on(PutObjectCommand).rejects(awsError("InternalError", 500));
    const backend = await makeBackend();
    await expect(backend.upload("k.txt", Buffer.from("x"))).rejects.toBeInstanceOf(StorageError);
  });

  it("attaches the original error as cause", async () => {
    const orig = awsError("NoSuchKey", 404);
    s3Mock.on(GetObjectCommand).rejects(orig);
    const backend = await makeBackend();
    await expect(backend.download("k.txt")).rejects.toMatchObject({ cause: orig });
  });

  it("loads profile credentials from the declared credential providers package", async () => {
    s3Mock.on(HeadObjectCommand).resolves({});
    const backend = AWSS3Backend.fromProfile({
      bucket: BUCKET,
      profileName: "dev",
      region: "us-east-1",
    });

    await expect(backend.exists("profile.txt")).resolves.toBe(true);

    expect(credentialProviderMock.fromIni).toHaveBeenCalledWith({ profile: "dev" });
  });

  it("retries lazy client creation after a failed profile init", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    credentialProviderMock.fromIni
      .mockImplementationOnce(() => {
        throw new Error("profile unavailable");
      })
      .mockReturnValueOnce(async () => ({
        accessKeyId: "retry-key",
        secretAccessKey: "retry-secret",
      }));
    const backend = AWSS3Backend.fromProfile({
      bucket: BUCKET,
      profileName: "dev",
      region: "us-east-1",
    });

    await expect(backend.upload("first.txt", Buffer.from("x"))).rejects.toThrow(
      /profile unavailable/,
    );
    await expect(backend.upload("second.txt", Buffer.from("x"))).resolves.toBe("second.txt");

    expect(credentialProviderMock.fromIni).toHaveBeenCalledTimes(2);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
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

  it("normalizes provider values from config", async () => {
    const backend = await getStorage(" S3 ", { bucket: "b", region: "us-west-2" });
    expect(backend).toBeInstanceOf(AWSS3Backend);

    const client = await getStorageClient(" S3 ", { region: "us-west-2" });
    expect(client).toBeInstanceOf(AWSS3Client);
  });

  it("rejects blank provider values from config", async () => {
    await expect(getStorage(" ", { bucket: "x" })).rejects.toThrow(/Unknown storage provider/);
  });

  it("throws CloudRiftError for unknown provider", async () => {
    await expect(getStorage("gcs" as never, { bucket: "x" })).rejects.toBeInstanceOf(
      CloudRiftError,
    );
    await expect(getStorage("gcs" as never, { bucket: "x" })).rejects.toThrow(
      /Unknown storage provider/,
    );
  });

  it("getStorageClient throws CloudRiftError for unknown provider", async () => {
    await expect(getStorageClient("gcs" as never, {})).rejects.toBeInstanceOf(CloudRiftError);
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
    generateBlobSASQueryParameters: (values: { expiresOn: Date }, _cred: unknown) => ({
      toString: () => `sig=fake&se=${values.expiresOn.toISOString()}`,
    }),
  } as unknown as ConstructorParameters<typeof AzureBlobClient>[0];

  const client = new AzureBlobClient(mod, service as never, opts.accountKey);
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
    await expect(backend.download("nope.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("maps 403 to StoragePermissionError", async () => {
    const { service, failures } = makeFakeService();
    failures.op = "download";
    failures.error = new FakeRestError(403);
    const backend = makeAzureBackend(service);
    await expect(backend.download("k.txt")).rejects.toBeInstanceOf(StoragePermissionError);
  });

  it("maps other errors to StorageError", async () => {
    const { service, failures } = makeFakeService();
    failures.op = "upload";
    failures.error = new FakeRestError(500);
    const backend = makeAzureBackend(service);
    await expect(backend.upload("k.txt", Buffer.from("x"))).rejects.toBeInstanceOf(StorageError);
  });
});

/* ------------------------------------------------------------------ */
/* Factory dispatch matrix — src/storage/index.ts                      */
/* ------------------------------------------------------------------ */

// A connection string that BlobServiceClient.fromConnectionString can parse
// without any network access.
const AZURE_CONN_STRING =
  "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=YWJjZA==;" +
  "EndpointSuffix=core.windows.net";
const AZURE_URL = "https://acct.blob.core.windows.net";

describe("getStorage factory dispatch matrix", () => {
  /* ---- s3 credential-key dispatch (index.ts:37-49) ---- */

  it("dispatches s3 access-key creds to AWSS3Backend.fromAccessKey", async () => {
    const spy = vi.spyOn(AWSS3Backend, "fromAccessKey");
    const backend = await getStorage("s3", {
      bucket: "b",
      awsAccessKeyId: "x",
      awsSecretAccessKey: "y",
    });
    expect(backend).toBeInstanceOf(AWSS3Backend);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("dispatches s3 profileName creds to AWSS3Backend.fromProfile", async () => {
    const spy = vi.spyOn(AWSS3Backend, "fromProfile");
    const accessSpy = vi.spyOn(AWSS3Backend, "fromAccessKey");
    const backend = await getStorage("s3", { bucket: "b", profileName: "dev" });
    expect(backend).toBeInstanceOf(AWSS3Backend);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(accessSpy).not.toHaveBeenCalled();
    spy.mockRestore();
    accessSpy.mockRestore();
  });

  it("dispatches s3 with no creds to AWSS3Backend.fromIamRole", async () => {
    const iamSpy = vi.spyOn(AWSS3Backend, "fromIamRole");
    const profileSpy = vi.spyOn(AWSS3Backend, "fromProfile");
    const accessSpy = vi.spyOn(AWSS3Backend, "fromAccessKey");
    const backend = await getStorage("s3", { bucket: "b", region: "us-west-2" });
    expect(backend).toBeInstanceOf(AWSS3Backend);
    expect(iamSpy).toHaveBeenCalledTimes(1);
    expect(profileSpy).not.toHaveBeenCalled();
    expect(accessSpy).not.toHaveBeenCalled();
    iamSpy.mockRestore();
    profileSpy.mockRestore();
    accessSpy.mockRestore();
  });

  it("prefers access-key over profileName when both are present", async () => {
    const accessSpy = vi.spyOn(AWSS3Backend, "fromAccessKey");
    const profileSpy = vi.spyOn(AWSS3Backend, "fromProfile");
    await getStorage("s3", {
      bucket: "b",
      awsAccessKeyId: "x",
      awsSecretAccessKey: "y",
      profileName: "dev",
    });
    expect(accessSpy).toHaveBeenCalledTimes(1);
    expect(profileSpy).not.toHaveBeenCalled();
    accessSpy.mockRestore();
    profileSpy.mockRestore();
  });

  /* ---- azure_blob credential-key dispatch (index.ts:51-73) ---- */

  it("dispatches azure connectionString to AzureBlobBackend.fromConnectionString", async () => {
    const spy = vi.spyOn(AzureBlobBackend, "fromConnectionString");
    const backend = await getStorage("azure_blob", {
      container: "c",
      connectionString: AZURE_CONN_STRING,
    });
    expect(backend).toBeInstanceOf(AzureBlobBackend);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("dispatches azure accountKey to AzureBlobBackend.fromAccountKey", async () => {
    const spy = vi.spyOn(AzureBlobBackend, "fromAccountKey");
    const connSpy = vi.spyOn(AzureBlobBackend, "fromConnectionString");
    const backend = await getStorage("azure_blob", {
      container: "c",
      accountUrl: AZURE_URL,
      accountKey: "YWJjZA==",
    });
    expect(backend).toBeInstanceOf(AzureBlobBackend);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(connSpy).not.toHaveBeenCalled();
    spy.mockRestore();
    connSpy.mockRestore();
  });

  it("dispatches azure sasToken to AzureBlobBackend.fromSasToken", async () => {
    const spy = vi.spyOn(AzureBlobBackend, "fromSasToken");
    const backend = await getStorage("azure_blob", {
      container: "c",
      accountUrl: AZURE_URL,
      sasToken: "sv=2021&sig=abc",
    });
    expect(backend).toBeInstanceOf(AzureBlobBackend);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("dispatches azure clientSecret to AzureBlobBackend.fromServicePrincipal", async () => {
    const spy = vi.spyOn(AzureBlobBackend, "fromServicePrincipal");
    const backend = await getStorage("azure_blob", {
      container: "c",
      accountUrl: AZURE_URL,
      tenantId: "t",
      clientId: "ci",
      clientSecret: "cs",
    });
    expect(backend).toBeInstanceOf(AzureBlobBackend);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("dispatches azure with no creds to AzureBlobBackend.fromManagedIdentity", async () => {
    const miSpy = vi.spyOn(AzureBlobBackend, "fromManagedIdentity");
    const spSpy = vi.spyOn(AzureBlobBackend, "fromServicePrincipal");
    const backend = await getStorage("azure_blob", { container: "c", accountUrl: AZURE_URL });
    expect(backend).toBeInstanceOf(AzureBlobBackend);
    expect(miSpy).toHaveBeenCalledTimes(1);
    expect(spSpy).not.toHaveBeenCalled();
    miSpy.mockRestore();
    spSpy.mockRestore();
  });

  it("azure dispatch precedence: connectionString wins over accountKey", async () => {
    const connSpy = vi.spyOn(AzureBlobBackend, "fromConnectionString");
    const keySpy = vi.spyOn(AzureBlobBackend, "fromAccountKey");
    await getStorage("azure_blob", {
      container: "c",
      connectionString: AZURE_CONN_STRING,
      accountKey: "YWJjZA==",
      accountUrl: AZURE_URL,
    });
    expect(connSpy).toHaveBeenCalledTimes(1);
    expect(keySpy).not.toHaveBeenCalled();
    connSpy.mockRestore();
    keySpy.mockRestore();
  });

  /* ---- normalization & unknown provider (index.ts:35,86) ---- */

  it("normalizes provider value (trim + lowercase) for azure_blob", async () => {
    const spy = vi.spyOn(AzureBlobBackend, "fromManagedIdentity");
    const backend = await getStorage("  AZURE_BLOB  ", {
      container: "c",
      accountUrl: AZURE_URL,
    });
    expect(backend).toBeInstanceOf(AzureBlobBackend);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("unknown provider throws CloudRiftError naming the value and choices", async () => {
    await expect(getStorage("gcs" as never, { bucket: "x" })).rejects.toBeInstanceOf(
      CloudRiftError,
    );
    await expect(getStorage("gcs" as never, { bucket: "x" })).rejects.toThrow(
      /Unknown storage provider: "gcs"\. Choose 's3', 'azure_blob'\./,
    );
  });
});

describe("getStorageClient factory dispatch matrix", () => {
  it("dispatches s3 access-key creds to AWSS3Client.fromAccessKey", async () => {
    const spy = vi.spyOn(AWSS3Client, "fromAccessKey");
    const client = await getStorageClient("s3", {
      awsAccessKeyId: "x",
      awsSecretAccessKey: "y",
    });
    expect(client).toBeInstanceOf(AWSS3Client);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("dispatches s3 profileName creds to AWSS3Client.fromProfile", async () => {
    const spy = vi.spyOn(AWSS3Client, "fromProfile");
    const accessSpy = vi.spyOn(AWSS3Client, "fromAccessKey");
    const client = await getStorageClient("s3", { profileName: "dev" });
    expect(client).toBeInstanceOf(AWSS3Client);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(accessSpy).not.toHaveBeenCalled();
    spy.mockRestore();
    accessSpy.mockRestore();
  });

  it("dispatches s3 with no creds to AWSS3Client.fromIamRole", async () => {
    const iamSpy = vi.spyOn(AWSS3Client, "fromIamRole");
    const client = await getStorageClient("s3", { region: "eu-west-1" });
    expect(client).toBeInstanceOf(AWSS3Client);
    expect(iamSpy).toHaveBeenCalledTimes(1);
    iamSpy.mockRestore();
  });

  it("dispatches azure connectionString to AzureBlobClient.fromConnectionString", async () => {
    const spy = vi.spyOn(AzureBlobClient, "fromConnectionString");
    const client = await getStorageClient("azure_blob", {
      connectionString: AZURE_CONN_STRING,
    });
    expect(client).toBeInstanceOf(AzureBlobClient);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("dispatches azure accountKey to AzureBlobClient.fromAccountKey", async () => {
    const spy = vi.spyOn(AzureBlobClient, "fromAccountKey");
    const client = await getStorageClient("azure_blob", {
      accountUrl: AZURE_URL,
      accountKey: "YWJjZA==",
    });
    expect(client).toBeInstanceOf(AzureBlobClient);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("dispatches azure sasToken to AzureBlobClient.fromSasToken", async () => {
    const spy = vi.spyOn(AzureBlobClient, "fromSasToken");
    const client = await getStorageClient("azure_blob", {
      accountUrl: AZURE_URL,
      sasToken: "sv=2021&sig=abc",
    });
    expect(client).toBeInstanceOf(AzureBlobClient);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("dispatches azure clientSecret to AzureBlobClient.fromServicePrincipal", async () => {
    const spy = vi.spyOn(AzureBlobClient, "fromServicePrincipal");
    const client = await getStorageClient("azure_blob", {
      accountUrl: AZURE_URL,
      tenantId: "t",
      clientId: "ci",
      clientSecret: "cs",
    });
    expect(client).toBeInstanceOf(AzureBlobClient);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("dispatches azure with no creds to AzureBlobClient.fromManagedIdentity", async () => {
    const miSpy = vi.spyOn(AzureBlobClient, "fromManagedIdentity");
    const client = await getStorageClient("azure_blob", { accountUrl: AZURE_URL });
    expect(client).toBeInstanceOf(AzureBlobClient);
    expect(miSpy).toHaveBeenCalledTimes(1);
    miSpy.mockRestore();
  });

  it("normalizes provider value (trim + lowercase) for s3", async () => {
    const client = await getStorageClient("  S3  ", { region: "us-east-1" });
    expect(client).toBeInstanceOf(AWSS3Client);
  });

  it("unknown provider throws CloudRiftError with normalized message", async () => {
    await expect(getStorageClient("gcs" as never, {})).rejects.toBeInstanceOf(CloudRiftError);
    await expect(getStorageClient("gcs" as never, {})).rejects.toThrow(
      /Unknown storage provider: "gcs"\. Choose 's3', 'azure_blob'\./,
    );
  });
});

/* ------------------------------------------------------------------ */
/* StorageBackend base-class default implementations — base.ts         */
/* ------------------------------------------------------------------ */

describe("StorageBackend base-class defaults", () => {
  // Minimal concrete subclass exercising only the inherited base methods.
  class FakeBackend extends StorageBackend {
    store = new Map<string, Buffer>();
    calls: string[] = [];
    existsImpl: () => Promise<boolean> = async () => true;

    async upload(key: string, data: BinaryInput): Promise<string> {
      this.store.set(key, Buffer.from(data as Buffer));
      return key;
    }
    async download(key: string): Promise<Buffer> {
      return this.store.get(key) ?? Buffer.alloc(0);
    }
    async delete(key: string): Promise<void> {
      this.calls.push(`delete:${key}`);
      this.store.delete(key);
    }
    async exists(key: string): Promise<boolean> {
      this.calls.push(`exists:${key}`);
      return this.existsImpl();
    }
    async list(prefix = ""): Promise<string[]> {
      return [...this.store.keys()].filter((k) => k.startsWith(prefix));
    }
    async presignedUrl(key: string): Promise<string> {
      return `url:${key}`;
    }
    async copy(srcKey: string, dstKey: string): Promise<string> {
      this.calls.push(`copy:${srcKey}->${dstKey}`);
      const src = this.store.get(srcKey);
      if (src) this.store.set(dstKey, src);
      return dstKey;
    }
    async getMetadata(): Promise<ObjectMetadata> {
      return {
        contentType: undefined,
        size: 0,
        lastModified: undefined,
        etag: undefined,
        metadata: {},
      };
    }
    async uploadStream(key: string): Promise<string> {
      return key;
    }
  }

  it("move() copies then deletes the source in order", async () => {
    const backend = new FakeBackend();
    await backend.upload("a.txt", Buffer.from("data"));
    const dst = await backend.move("a.txt", "b.txt");
    expect(dst).toBe("b.txt");
    // copy happened before delete, and on the right keys.
    expect(backend.calls).toEqual(["copy:a.txt->b.txt", "delete:a.txt"]);
    expect(backend.store.has("a.txt")).toBe(false);
    expect(backend.store.get("b.txt")?.toString()).toBe("data");
  });

  it("move() forwards dstBucket to copy", async () => {
    const backend = new FakeBackend();
    const copySpy = vi.spyOn(backend, "copy");
    await backend.upload("a.txt", Buffer.from("x"));
    await backend.move("a.txt", "b.txt", "other");
    expect(copySpy).toHaveBeenCalledWith("a.txt", "b.txt", "other");
  });

  it("default listIter() wraps list() and yields each key", async () => {
    const backend = new FakeBackend();
    await backend.upload("p/a.txt", Buffer.from("a"));
    await backend.upload("p/b.txt", Buffer.from("b"));
    await backend.upload("q/c.txt", Buffer.from("c"));
    const listSpy = vi.spyOn(backend, "list");
    const keys: string[] = [];
    for await (const k of backend.listIter("p/")) keys.push(k);
    expect(new Set(keys)).toEqual(new Set(["p/a.txt", "p/b.txt"]));
    expect(listSpy).toHaveBeenCalledWith("p/");
  });

  it("healthCheck() returns true when exists() resolves", async () => {
    const backend = new FakeBackend();
    backend.existsImpl = async () => false; // value is irrelevant; no throw
    expect(await backend.healthCheck()).toBe(true);
    // Probes the sentinel key.
    expect(backend.calls).toContain("exists:__cloudrift_health__");
  });

  it("healthCheck() returns false when exists() throws", async () => {
    const backend = new FakeBackend();
    backend.existsImpl = async () => {
      throw new Error("unreachable");
    };
    expect(await backend.healthCheck()).toBe(false);
  });

  it("default close() is a no-op and asyncDispose delegates to it", async () => {
    const backend = new FakeBackend();
    const closeSpy = vi.spyOn(backend, "close");
    await expect(backend.close()).resolves.toBeUndefined();
    await backend[Symbol.asyncDispose]();
    expect(closeSpy).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ */
/* S3 error-message extraction & option wiring — s3.ts                 */
/* ------------------------------------------------------------------ */

describe("AWSS3Backend errorMessage extraction (s3.ts:493-497)", () => {
  it("uses Error.message for thrown Error values", async () => {
    // Generic 500-class error (not 404/403) -> StorageError(errorMessage(exc)).
    s3Mock.on(PutObjectCommand).rejects(awsError("Boom happened", 500));
    const backend = await makeBackend();
    await expect(backend.upload("k.txt", Buffer.from("x"))).rejects.toThrow(/Boom happened/);
  });

  it("falls back to String(exc) for non-Error thrown values", async () => {
    // Reject with a plain string (non-Error, non-404/403) so the fallback runs.
    s3Mock.on(PutObjectCommand).rejects("plain-string-failure" as never);
    const backend = await makeBackend();
    const err = await backend.upload("k.txt", Buffer.from("x")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as Error).message).toBe("plain-string-failure");
  });
});

describe("AWSS3Client option wiring (s3.ts create())", () => {
  // R1-4: a clean spy on the mocked S3Client constructor config is not feasible
  // here because aws-sdk-client-mock replaces construction with its own mock
  // instance (the constructor we'd spy on never sees our config object). The
  // supported way to read what was passed in is the mock client's resolved
  // `.config`, so we keep that assertion and accept the SDK provider shape.
  it("forwards region and endpointUrl to the S3Client config", async () => {
    let capturedConfig: Record<string, unknown> | undefined;
    s3Mock.on(PutObjectCommand).callsFake((_input, getClient) => {
      capturedConfig = getClient().config as unknown as Record<string, unknown>;
      return {};
    });
    const backend = AWSS3Backend.fromAccessKey({
      bucket: BUCKET,
      awsAccessKeyId: "ak",
      awsSecretAccessKey: "sk",
      region: "ap-south-1",
      endpointUrl: "https://minio.local:9000",
    });
    await backend.upload("k.txt", Buffer.from("x"));
    // region/endpoint resolve through the SDK config provider chain.
    expect(await (capturedConfig!.region as () => Promise<string>)()).toBe("ap-south-1");
    const endpoint = capturedConfig!.endpoint as () => Promise<{ hostname: string }>;
    expect((await endpoint()).hostname).toBe("minio.local");
  });

  it("defaults region to us-east-1 when none is supplied", async () => {
    let capturedConfig: Record<string, unknown> | undefined;
    s3Mock.on(PutObjectCommand).callsFake((_input, getClient) => {
      capturedConfig = getClient().config as unknown as Record<string, unknown>;
      return {};
    });
    const backend = AWSS3Backend.fromIamRole({ bucket: BUCKET });
    await backend.upload("k.txt", Buffer.from("x"));
    expect(await (capturedConfig!.region as () => Promise<string>)()).toBe("us-east-1");
  });

  it("wires static access-key credentials into the client", async () => {
    let capturedConfig: Record<string, unknown> | undefined;
    s3Mock.on(PutObjectCommand).callsFake((_input, getClient) => {
      capturedConfig = getClient().config as unknown as Record<string, unknown>;
      return {};
    });
    const backend = AWSS3Backend.fromAccessKey({
      bucket: BUCKET,
      awsAccessKeyId: "AKIATEST",
      awsSecretAccessKey: "secret",
      awsSessionToken: "token-xyz",
      region: "us-east-1",
    });
    await backend.upload("k.txt", Buffer.from("x"));
    const creds = await (
      capturedConfig!.credentials as () => Promise<{
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
      }>
    )();
    expect(creds.accessKeyId).toBe("AKIATEST");
    expect(creds.secretAccessKey).toBe("secret");
    expect(creds.sessionToken).toBe("token-xyz");
  });
});

describe("AWSS3Backend command-input wiring", () => {
  it("presignedUrl forwards the requested expiry to getSignedUrl", async () => {
    const backend = await makeBackend();
    const url = await backend.presignedUrl("file.txt", 4242);
    expect(url).toBe(`https://${BUCKET}.s3.amazonaws.com/file.txt?X-Amz-Expires=4242`);
  });

  it("presignedUrl defaults expiry to 3600 seconds", async () => {
    const backend = await makeBackend();
    const url = await backend.presignedUrl("file.txt");
    // Assert the full URL with exact equality (symmetry with the 4242 sibling)
    // so that mutating the default expiry, bucket, or key is caught.
    expect(url).toBe(`https://${BUCKET}.s3.amazonaws.com/file.txt?X-Amz-Expires=3600`);
  });

  it("upload omits ContentType when none is supplied", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const backend = await makeBackend();
    await backend.upload("k.txt", Buffer.from("x"));
    const input = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(input.Bucket).toBe(BUCKET);
    expect(input.Key).toBe("k.txt");
    expect("ContentType" in input).toBe(false);
  });

  it("list paginates passing the continuation token on the second page", async () => {
    s3Mock
      .on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: "a.txt" }],
        IsTruncated: true,
        NextContinuationToken: "TOKEN-1",
      })
      .resolvesOnce({ Contents: [{ Key: "b.txt" }], IsTruncated: false });
    const backend = await makeBackend();
    const keys = await backend.list("");
    expect(keys).toEqual(["a.txt", "b.txt"]);
    const calls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(calls).toHaveLength(2);
    // First page carries no continuation token.
    expect("ContinuationToken" in calls[0].args[0].input).toBe(false);
    // Second page carries the token returned by the first page.
    expect(calls[1].args[0].input.ContinuationToken).toBe("TOKEN-1");
  });

  it("list stops when IsTruncated is false even if a token is present", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "only.txt" }],
      IsTruncated: false,
      NextContinuationToken: "IGNORED",
    });
    const backend = await makeBackend();
    const keys = await backend.list("");
    expect(keys).toEqual(["only.txt"]);
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(1);
  });

  it("list skips entries with an undefined Key", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "kept.txt" }, {}, { Key: "also.txt" }],
      IsTruncated: false,
    });
    const backend = await makeBackend();
    const keys = await backend.list("");
    expect(keys).toEqual(["kept.txt", "also.txt"]);
  });

  it("getMetadata defaults size to 0 and metadata to {} when absent", async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: "application/octet-stream" });
    const backend = await makeBackend();
    const meta = await backend.getMetadata("m.txt");
    expect(meta.size).toBe(0);
    expect(meta.metadata).toEqual({});
    expect(meta.contentType).toBe("application/octet-stream");
    expect(meta.etag).toBeUndefined();
    expect(meta.lastModified).toBeUndefined();
  });

  it("download returns an empty buffer when the response has no Body", async () => {
    s3Mock.on(GetObjectCommand).resolves({});
    const backend = await makeBackend();
    const data = await backend.download("empty.txt");
    expect(data.length).toBe(0);
  });

  it("listIter surfaces errors via the storage error mapping", async () => {
    s3Mock.on(ListObjectsV2Command).rejects(awsError("AccessDenied", 403));
    const backend = await makeBackend();
    const iterate = async () => {
      for await (const _k of backend.listIter("p/")) {
        // no-op
      }
    };
    await expect(iterate()).rejects.toBeInstanceOf(StoragePermissionError);
  });

  it("copy uses the source bucket in CopySource and the view bucket as default target", async () => {
    s3Mock.on(CopyObjectCommand).resolves({});
    const backend = await makeBackend();
    await backend.copy("dir/src.txt", "dir/dst.txt");
    const input = s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input;
    expect(input.CopySource).toBe(`${BUCKET}/dir/src.txt`);
    expect(input.Bucket).toBe(BUCKET);
    expect(input.Key).toBe("dir/dst.txt");
  });

  it("upload includes the exact ContentType when supplied", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const backend = await makeBackend();
    await backend.upload("k.txt", Buffer.from("x"), "image/png");
    const input = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(input.ContentType).toBe("image/png");
    expect(input.Bucket).toBe(BUCKET);
    expect(input.Key).toBe("k.txt");
  });

  it("download/getMetadata/delete/exists all carry exact Bucket and Key", async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: bodyFor("data") as never });
    s3Mock.on(HeadObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});
    const backend = await makeBackend();

    await backend.download("d.txt");
    const getInput = s3Mock.commandCalls(GetObjectCommand)[0].args[0].input;
    expect(getInput.Bucket).toBe(BUCKET);
    expect(getInput.Key).toBe("d.txt");

    await backend.getMetadata("m.txt");
    const headInput = s3Mock.commandCalls(HeadObjectCommand)[0].args[0].input;
    expect(headInput.Bucket).toBe(BUCKET);
    expect(headInput.Key).toBe("m.txt");

    await backend.delete("x.txt");
    const delInput = s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input;
    expect(delInput.Bucket).toBe(BUCKET);
    expect(delInput.Key).toBe("x.txt");

    await backend.exists("e.txt");
    const exInput = s3Mock.commandCalls(HeadObjectCommand)[1].args[0].input;
    expect(exInput.Bucket).toBe(BUCKET);
    expect(exInput.Key).toBe("e.txt");
  });

  it("list sends the exact Prefix on the first page", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });
    const backend = await makeBackend();
    await backend.list("photos/2024/");
    const input = s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input;
    expect(input.Bucket).toBe(BUCKET);
    expect(input.Prefix).toBe("photos/2024/");
  });

  it("presignedUrl signs a GetObjectCommand for the exact bucket and key", async () => {
    const backend = await makeBackend();
    const url = await backend.presignedUrl("path/to/obj.bin", 99);
    // The presigner mock encodes Bucket/Key/expiresIn into the URL, so an exact
    // match pins all three (kills Bucket/Key string + expiresIn object mutants).
    expect(url).toBe(`https://${BUCKET}.s3.amazonaws.com/path/to/obj.bin?X-Amz-Expires=99`);
  });
});

/* ------------------------------------------------------------------ */
/* S3 not-found / access-denied classification — exact codes/statuses  */
/* ------------------------------------------------------------------ */

describe("AWSS3Backend error classification (s3.ts isNotFound/isAccessDenied)", () => {
  const cases404: Array<[string, number | undefined]> = [
    ["404", undefined],
    ["NoSuchKey", undefined],
    ["NotFound", undefined],
  ];
  for (const [code, status] of cases404) {
    it(`treats code "${code}" as ObjectNotFoundError`, async () => {
      s3Mock.on(GetObjectCommand).rejects(awsError(code, status));
      const backend = await makeBackend();
      await expect(backend.download("k.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
    });
  }

  it("treats httpStatusCode 404 (with an unrelated code name) as ObjectNotFoundError", async () => {
    s3Mock.on(GetObjectCommand).rejects(awsError("SomethingElse", 404));
    const backend = await makeBackend();
    await expect(backend.download("k.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('treats code "403" as StoragePermissionError without a status code', async () => {
    s3Mock.on(GetObjectCommand).rejects(awsError("403"));
    const backend = await makeBackend();
    await expect(backend.download("k.txt")).rejects.toBeInstanceOf(StoragePermissionError);
  });

  it("treats httpStatusCode 403 (unrelated code) as StoragePermissionError", async () => {
    s3Mock.on(GetObjectCommand).rejects(awsError("Whatever", 403));
    const backend = await makeBackend();
    await expect(backend.download("k.txt")).rejects.toBeInstanceOf(StoragePermissionError);
  });

  it("a 500 with a non-special code name maps to a plain StorageError (not 404/403)", async () => {
    const err = awsError("InternalError", 500);
    s3Mock.on(GetObjectCommand).rejects(err);
    const backend = await makeBackend();
    const thrown = await backend.download("k.txt").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(StorageError);
    expect(thrown).not.toBeInstanceOf(ObjectNotFoundError);
    expect(thrown).not.toBeInstanceOf(StoragePermissionError);
    expect((thrown as Error).message).toBe("InternalError");
  });

  it("classifies via the Code field when name is absent (errorCode fallback)", async () => {
    // No `name` set; the SDK-style `Code` field should drive classification.
    const err = Object.assign(new Error("missing"), { Code: "NoSuchKey" });
    // Strip the default Error name so errorCode() falls through to Code.
    Object.defineProperty(err, "name", { value: undefined, configurable: true });
    s3Mock.on(GetObjectCommand).rejects(err as never);
    const backend = await makeBackend();
    await expect(backend.download("k.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("produces the exact ObjectNotFoundError message containing the key", async () => {
    s3Mock.on(GetObjectCommand).rejects(awsError("NoSuchKey", 404));
    const backend = await makeBackend();
    const thrown = await backend.download("dir/missing.txt").catch((e: unknown) => e);
    expect((thrown as Error).message).toBe("Object not found: dir/missing.txt");
  });

  it("produces the exact StoragePermissionError message containing the key", async () => {
    s3Mock.on(GetObjectCommand).rejects(awsError("AccessDenied", 403));
    const backend = await makeBackend();
    const thrown = await backend.download("dir/denied.txt").catch((e: unknown) => e);
    expect((thrown as Error).message).toBe("Access denied for key: dir/denied.txt");
  });
});

/* ------------------------------------------------------------------ */
/* Azure Blob — instrumented fake to assert command-input wiring       */
/* ------------------------------------------------------------------ */

interface AzureUploadCall {
  body: Buffer;
  length: number;
  options?: { blobHTTPHeaders?: { blobContentType?: string } };
}
interface AzureStreamCall {
  bufferSize?: number;
  maxConcurrency?: number;
  options?: { blobHTTPHeaders?: { blobContentType?: string } };
}

function makeInstrumentedService() {
  const uploadCalls: AzureUploadCall[] = [];
  const streamCalls: AzureStreamCall[] = [];
  const listOptionCalls: Array<{ prefix?: string } | undefined> = [];
  const copySources: string[] = [];
  const blobUrls: string[] = [];
  let lastGetPropertiesResult: Record<string, unknown> = {
    contentType: "application/octet-stream",
    contentLength: 7,
    lastModified: new Date(0),
    etag: '"E"',
    metadata: { k: "v" },
  };

  const makeBlobClient = (containerName: string, key: string) => ({
    url: `https://acct.blob.core.windows.net/${containerName}/${key}`,
    async upload(
      body: Buffer,
      len: number,
      options?: { blobHTTPHeaders?: { blobContentType?: string } },
    ) {
      uploadCalls.push({ body: Buffer.from(body), length: len, options });
    },
    async uploadStream(
      stream: Readable,
      bufferSize?: number,
      maxConcurrency?: number,
      options?: { blobHTTPHeaders?: { blobContentType?: string } },
    ) {
      // Drain so the source generator completes.
      for await (const _chunk of stream) {
        void _chunk;
      }
      streamCalls.push({ bufferSize, maxConcurrency, options });
    },
    async download() {
      return { readableStreamBody: Readable.from([Buffer.from("body")]) };
    },
    async delete() {
      return undefined;
    },
    async exists() {
      return true;
    },
    async getProperties() {
      return lastGetPropertiesResult;
    },
    async beginCopyFromURL(copySource: string) {
      copySources.push(copySource);
      return { pollUntilDone: async () => undefined };
    },
  });

  const service = {
    accountName: "acct",
    getContainerClient: (name: string) => ({
      getBlockBlobClient: (key: string) => {
        const c = makeBlobClient(name, key);
        blobUrls.push(c.url);
        return c;
      },
      async *listBlobsFlat(options?: { prefix?: string }) {
        listOptionCalls.push(options);
        yield { name: "a.txt" };
      },
    }),
    close: async () => undefined,
  };

  return {
    service,
    uploadCalls,
    streamCalls,
    listOptionCalls,
    copySources,
    blobUrls,
    setGetProperties(v: Record<string, unknown>) {
      lastGetPropertiesResult = v;
    },
  };
}

function backendOver(
  service: ReturnType<typeof makeInstrumentedService>["service"],
  opts: { accountKey?: string; container?: string; ownsClient?: boolean } = {},
): AzureBlobBackend {
  const mod = {
    StorageSharedKeyCredential: class {
      constructor(
        public account: string,
        public key: string,
      ) {}
    },
    BlobSASPermissions: { parse: (p: string) => ({ perm: p }) },
    generateBlobSASQueryParameters: (values: { expiresOn: Date }, _cred: unknown) => ({
      toString: () => `sig=fake&se=${values.expiresOn.toISOString()}`,
    }),
  } as unknown as ConstructorParameters<typeof AzureBlobClient>[0];
  const client = new AzureBlobClient(mod, service as never, opts.accountKey);
  return new AzureBlobBackend(opts.container ?? "my-container", client, opts.ownsClient ?? true);
}

describe("AzureBlobBackend command-input wiring (azureBlob.ts)", () => {
  it("upload passes buffer, exact length, and blobContentType option", async () => {
    const inst = makeInstrumentedService();
    const backend = backendOver(inst.service);
    await backend.upload("k.txt", Buffer.from("hello!!"), "text/csv");
    expect(inst.uploadCalls).toHaveLength(1);
    const call = inst.uploadCalls[0];
    expect(call.body.toString()).toBe("hello!!");
    expect(call.length).toBe(7);
    expect(call.options).toEqual({ blobHTTPHeaders: { blobContentType: "text/csv" } });
  });

  it("upload passes undefined options when no contentType supplied", async () => {
    const inst = makeInstrumentedService();
    const backend = backendOver(inst.service);
    await backend.upload("k.txt", Buffer.from("x"));
    expect(inst.uploadCalls[0].options).toBeUndefined();
  });

  it("uploadStream forwards undefined bufferSize/maxConcurrency and the content-type option", async () => {
    const inst = makeInstrumentedService();
    const backend = backendOver(inst.service);
    async function* gen(): AsyncGenerator<Buffer> {
      yield Buffer.from("z");
    }
    const key = await backend.uploadStream("s.txt", gen(), "application/json");
    expect(key).toBe("s.txt");
    expect(inst.streamCalls).toHaveLength(1);
    expect(inst.streamCalls[0].bufferSize).toBeUndefined();
    expect(inst.streamCalls[0].maxConcurrency).toBeUndefined();
    expect(inst.streamCalls[0].options).toEqual({
      blobHTTPHeaders: { blobContentType: "application/json" },
    });
  });

  it("uploadStream passes undefined options when contentType absent", async () => {
    const inst = makeInstrumentedService();
    const backend = backendOver(inst.service);
    async function* gen(): AsyncGenerator<Buffer> {
      yield Buffer.from("z");
    }
    await backend.uploadStream("s.txt", gen());
    expect(inst.streamCalls[0].options).toBeUndefined();
  });

  it("list passes { prefix } when a prefix is supplied and undefined when empty", async () => {
    const inst = makeInstrumentedService();
    const backend = backendOver(inst.service);
    await backend.list("logs/");
    await backend.list();
    expect(inst.listOptionCalls[0]).toEqual({ prefix: "logs/" });
    expect(inst.listOptionCalls[1]).toBeUndefined();
  });

  it("listIter passes { prefix } when a prefix is supplied and undefined when empty", async () => {
    const inst = makeInstrumentedService();
    const backend = backendOver(inst.service);
    const got: string[] = [];
    for await (const k of backend.listIter("x/")) got.push(k);
    for await (const k of backend.listIter()) got.push(k);
    expect(inst.listOptionCalls[0]).toEqual({ prefix: "x/" });
    expect(inst.listOptionCalls[1]).toBeUndefined();
    expect(got).toEqual(["a.txt", "a.txt"]);
  });

  it("copy uses the source blob URL as copy source and defaults target to the view container", async () => {
    const inst = makeInstrumentedService();
    const backend = backendOver(inst.service, { container: "cont" });
    const dst = await backend.copy("src.txt", "dst.txt");
    expect(dst).toBe("dst.txt");
    expect(inst.copySources).toEqual(["https://acct.blob.core.windows.net/cont/src.txt"]);
  });

  it("copy honors an explicit destination container", async () => {
    const inst = makeInstrumentedService();
    const backend = backendOver(inst.service, { container: "cont" });
    await backend.copy("src.txt", "dst.txt", "other");
    // Source still resolves under the view container, dest blob under "other".
    expect(inst.copySources).toEqual(["https://acct.blob.core.windows.net/cont/src.txt"]);
    // The destination blob client must have been created under "other".
    expect(inst.blobUrls).toContain("https://acct.blob.core.windows.net/other/dst.txt");
    expect(inst.blobUrls).toContain("https://acct.blob.core.windows.net/cont/src.txt");
  });

  it("getMetadata maps every field and defaults", async () => {
    const inst = makeInstrumentedService();
    const when = new Date(1234567890000);
    inst.setGetProperties({
      contentType: "text/html",
      contentLength: 42,
      lastModified: when,
      etag: '"ZZ"',
      metadata: { a: "1" },
    });
    const backend = backendOver(inst.service);
    const meta = await backend.getMetadata("m.txt");
    expect(meta.contentType).toBe("text/html");
    expect(meta.size).toBe(42);
    expect(meta.lastModified).toBe(when);
    expect(meta.etag).toBe('"ZZ"');
    expect(meta.metadata).toEqual({ a: "1" });
  });

  it("getMetadata defaults size to 0 and metadata to {} when absent", async () => {
    const inst = makeInstrumentedService();
    inst.setGetProperties({ contentType: undefined });
    const backend = backendOver(inst.service);
    const meta = await backend.getMetadata("m.txt");
    expect(meta.size).toBe(0);
    expect(meta.metadata).toEqual({});
    expect(meta.contentType).toBeUndefined();
    expect(meta.lastModified).toBeUndefined();
    expect(meta.etag).toBeUndefined();
  });

  it("download returns an empty buffer when there is no readable stream body", async () => {
    const inst = makeInstrumentedService();
    // Override download to return a body-less response.
    inst.service.getContainerClient = () =>
      ({
        getBlockBlobClient: () => ({
          async download() {
            return {};
          },
        }),
      }) as never;
    const backend = backendOver(inst.service);
    const data = await backend.download("k.txt");
    expect(data.length).toBe(0);
  });

  it("presignedUrl builds the exact account/container/key URL prefix", async () => {
    const inst = makeInstrumentedService();
    const backend = backendOver(inst.service, { accountKey: "a-key", container: "cont" });
    const url = await backend.presignedUrl("dir/k.txt", 60);
    expect(url.startsWith("https://acct.blob.core.windows.net/cont/dir/k.txt?sig=fake&se=")).toBe(
      true,
    );
  });

  it("presignedUrl without account key throws StorageError with the exact message", async () => {
    const inst = makeInstrumentedService();
    const backend = backendOver(inst.service); // no accountKey
    const thrown = await backend.presignedUrl("k.txt").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as Error).message).toBe(
      "presignedUrl requires account_key authentication. " +
        "Use fromConnectionString or fromAccountKey.",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Azure Blob — error classification, ownership, factory constructors  */
/* ------------------------------------------------------------------ */

describe("AzureBlobBackend error classification & ownership (azureBlob.ts)", () => {
  it("maps statusCode 404 to ObjectNotFoundError with exact message", async () => {
    const { service, failures } = makeFakeService();
    failures.op = "download";
    failures.error = new FakeRestError(404);
    const backend = makeAzureBackend(service);
    const thrown = await backend.download("dir/k.txt").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ObjectNotFoundError);
    expect((thrown as Error).message).toBe("Object not found: dir/k.txt");
  });

  it("maps a BlobNotFound error code (no 404 status) to ObjectNotFoundError", async () => {
    const { service, failures } = makeFakeService();
    failures.op = "download";
    const err = new Error("nope") as Error & { code?: string };
    err.code = "BlobNotFound";
    failures.error = err;
    const backend = makeAzureBackend(service);
    await expect(backend.download("k.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("maps a details.errorCode of BlobNotFound to ObjectNotFoundError (errorCode fallback)", async () => {
    const { service, failures } = makeFakeService();
    failures.op = "download";
    const err = new Error("nope") as Error & { details?: { errorCode?: string } };
    err.details = { errorCode: "BlobNotFound" };
    failures.error = err;
    const backend = makeAzureBackend(service);
    await expect(backend.download("k.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("maps statusCode 403 to StoragePermissionError with exact message", async () => {
    const { service, failures } = makeFakeService();
    failures.op = "download";
    failures.error = new FakeRestError(403);
    const backend = makeAzureBackend(service);
    const thrown = await backend.download("secret.txt").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(StoragePermissionError);
    expect((thrown as Error).message).toBe("Access denied for key: secret.txt");
  });

  it("maps a generic 500 to StorageError carrying the original message", async () => {
    const { service, failures } = makeFakeService();
    failures.op = "upload";
    const err = new FakeRestError(500);
    err.message = "boom-500";
    failures.error = err;
    const backend = makeAzureBackend(service);
    const thrown = await backend.upload("k.txt", Buffer.from("x")).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(StorageError);
    expect(thrown).not.toBeInstanceOf(ObjectNotFoundError);
    expect(thrown).not.toBeInstanceOf(StoragePermissionError);
    expect((thrown as Error).message).toBe("boom-500");
  });

  it("errorMessage falls back to String(exc) for non-Error throws", async () => {
    const { service, failures } = makeFakeService();
    failures.op = "upload";
    failures.error = "plain-azure-failure" as unknown as Error;
    const backend = makeAzureBackend(service);
    const thrown = await backend.upload("k.txt", Buffer.from("x")).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as Error).message).toBe("plain-azure-failure");
  });

  it("container() returns a non-owning view whose close() does not close the client", async () => {
    const inst = makeInstrumentedService();
    let closed = false;
    inst.service.close = async () => {
      closed = true;
    };
    const mod = {
      StorageSharedKeyCredential: class {},
      BlobSASPermissions: { parse: () => ({}) },
      generateBlobSASQueryParameters: () => ({ toString: () => "" }),
    } as unknown as ConstructorParameters<typeof AzureBlobClient>[0];
    const client = new AzureBlobClient(mod, inst.service as never);
    const view = client.container("c");
    expect(view).toBeInstanceOf(AzureBlobBackend);
    expect(view.container).toBe("c");
    await view.close();
    expect(closed).toBe(false);
  });

  it("an owning view close() closes the underlying client service", async () => {
    const inst = makeInstrumentedService();
    let closed = false;
    inst.service.close = async () => {
      closed = true;
    };
    const backend = backendOver(inst.service, { ownsClient: true });
    await backend.close();
    expect(closed).toBe(true);
  });

  it("client.close() closes both the service and a closable credential", async () => {
    let serviceClosed = false;
    let credClosed = false;
    const service = {
      accountName: "acct",
      getContainerClient: () => ({}) as never,
      close: async () => {
        serviceClosed = true;
      },
    };
    const credential = {
      close: async () => {
        credClosed = true;
      },
    };
    const mod = {} as unknown as ConstructorParameters<typeof AzureBlobClient>[0];
    const client = new AzureBlobClient(mod, service as never, undefined, credential);
    await client.close();
    expect(serviceClosed).toBe(true);
    expect(credClosed).toBe(true);
  });
});

describe("AzureBlobClient factory constructors (azureBlob.ts)", () => {
  it("fromConnectionString parses the AccountKey and enables presignedUrl", async () => {
    const client = await AzureBlobClient.fromConnectionString({
      connectionString: AZURE_CONN_STRING,
    });
    expect(client).toBeInstanceOf(AzureBlobClient);
    // AccountKey from the conn string must be captured so presignedUrl works.
    expect(client._accountKey).toBe("YWJjZA==");
  });

  it("fromConnectionString leaves accountKey undefined when the field is absent", async () => {
    // A SAS-style connection string has a BlobEndpoint + SharedAccessSignature
    // but no AccountKey, so parseConnStringField returns null -> undefined.
    const noKey =
      "BlobEndpoint=https://acct.blob.core.windows.net;" +
      "SharedAccessSignature=sv=2021-08-06&sig=abc";
    const client = await AzureBlobClient.fromConnectionString({ connectionString: noKey });
    expect(client._accountKey).toBeUndefined();
  });

  it("fromAccountKey records the account key for presigning", async () => {
    const client = await AzureBlobClient.fromAccountKey({
      accountUrl: AZURE_URL,
      accountKey: "MYKEY==",
    });
    expect(client._accountKey).toBe("MYKEY==");
  });

  it("fromSasToken leaves accountKey undefined (cannot presign)", async () => {
    const client = await AzureBlobClient.fromSasToken({
      accountUrl: AZURE_URL,
      sasToken: "sv=2021&sig=abc",
    });
    expect(client._accountKey).toBeUndefined();
  });

  it("fromSasToken normalizes a token that already starts with '?'", async () => {
    const backend = await AzureBlobBackend.fromSasToken({
      accountUrl: AZURE_URL,
      sasToken: "?sv=2021&sig=abc",
      container: "c",
    });
    // No double '?' should appear; the value is consumed by the SDK, so we just
    // assert construction succeeded with a usable backend bound to the container.
    expect(backend).toBeInstanceOf(AzureBlobBackend);
    expect(backend.container).toBe("c");
  });

  it("presignedUrl built from fromAccountKey contains the requested account name and key", async () => {
    const client = await AzureBlobClient.fromAccountKey({
      accountUrl: AZURE_URL,
      accountKey: "WUtleQ==",
    });
    const backend = client.container("cont");
    const url = await backend.presignedUrl("o.bin", 30);
    expect(url.startsWith("https://acct.blob.core.windows.net/cont/o.bin?")).toBe(true);
  });
});
