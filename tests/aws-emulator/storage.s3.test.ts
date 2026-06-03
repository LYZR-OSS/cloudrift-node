import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getStorage } from "../../src/index.js";
import type { StorageBackend } from "../../src/index.js";
import { ObjectNotFoundError } from "../../src/core/errors.js";
import { awsOptions, createBucket, emptyAndDeleteBucket, uniqueName } from "./harness.js";

/**
 * Black-box S3 behavior against LocalStack, driven entirely through the public
 * `getStorage("s3", ...)` factory. Proves read-after-write, delete visibility,
 * list pagination/prefixing, copy/move, metadata persistence, stream upload, and
 * presigned-URL fetchability — the things SDK command-shape mocks cannot.
 */
describe("S3 storage (LocalStack)", () => {
  let bucket: string;
  let storage: StorageBackend;

  beforeAll(async () => {
    bucket = uniqueName("bucket");
    await createBucket(bucket);
    storage = await getStorage("s3", { ...awsOptions(), bucket });
  });

  afterAll(async () => {
    await storage.close();
    await emptyAndDeleteBucket(bucket);
  });

  it("uploads then downloads identical bytes with content type", async () => {
    const key = "read-after-write.txt";
    const body = Buffer.from("hello cloudrift", "utf8");
    await storage.upload(key, body, "text/plain");

    const downloaded = await storage.download(key);
    expect(downloaded.equals(body)).toBe(true);

    const meta = await storage.getMetadata(key);
    expect(meta.contentType).toBe("text/plain");
  });

  it("reports existence accurately", async () => {
    const key = "exists-probe.bin";
    expect(await storage.exists(key)).toBe(false);
    await storage.upload(key, Buffer.from([1, 2, 3]));
    expect(await storage.exists(key)).toBe(true);
  });

  it("lists and iterates keys filtered by prefix", async () => {
    const prefixA = `lists/alpha/${uniqueName("p")}/`;
    const prefixB = `lists/beta/${uniqueName("p")}/`;
    const aKeys = [`${prefixA}one`, `${prefixA}two`, `${prefixA}three`];
    const bKeys = [`${prefixB}one`, `${prefixB}two`];
    for (const key of [...aKeys, ...bKeys]) {
      await storage.upload(key, Buffer.from(key));
    }

    const listed = await storage.list(prefixA);
    expect(listed.sort()).toEqual([...aKeys].sort());

    const iterated: string[] = [];
    for await (const key of storage.listIter(prefixB)) {
      iterated.push(key);
    }
    expect(iterated.sort()).toEqual([...bKeys].sort());
  });

  it("copies leaving both objects present", async () => {
    const src = "copy/source.txt";
    const dst = "copy/dest.txt";
    await storage.upload(src, Buffer.from("copy me"));

    await storage.copy(src, dst);

    expect(await storage.exists(src)).toBe(true);
    expect(await storage.exists(dst)).toBe(true);
    expect((await storage.download(dst)).toString()).toBe("copy me");
  });

  it("moves leaving only the destination", async () => {
    const src = "move/source.txt";
    const dst = "move/dest.txt";
    await storage.upload(src, Buffer.from("move me"));

    await storage.move(src, dst);

    expect(await storage.exists(src)).toBe(false);
    expect(await storage.exists(dst)).toBe(true);
    expect((await storage.download(dst)).toString()).toBe("move me");
  });

  it("returns rich metadata", async () => {
    const key = "metadata.json";
    const body = Buffer.from('{"k":"v"}');
    await storage.upload(key, body, "application/json");

    const meta = await storage.getMetadata(key);
    expect(meta.contentType).toBe("application/json");
    expect(meta.size).toBe(body.length);
    expect(meta.etag).toBeTruthy();
    expect(meta.lastModified).toBeInstanceOf(Date);
  });

  it("deletes so the object is gone for exists and download", async () => {
    const key = "delete-me.txt";
    await storage.upload(key, Buffer.from("temp"));
    expect(await storage.exists(key)).toBe(true);

    await storage.delete(key);

    expect(await storage.exists(key)).toBe(false);
    await expect(storage.download(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("uploads from an async-iterable stream", async () => {
    const key = "stream-upload.bin";
    const parts = [Buffer.from("part-1;"), Buffer.from("part-2;"), Buffer.from("part-3")];
    async function* source(): AsyncIterable<Buffer> {
      for (const part of parts) {
        yield part;
      }
    }

    await storage.uploadStream(key, source(), "application/octet-stream");

    const downloaded = await storage.download(key);
    expect(downloaded.equals(Buffer.concat(parts))).toBe(true);
  });

  it("produces a fetchable presigned URL", async () => {
    const key = "presigned/object.txt";
    const body = Buffer.from("presigned payload");
    await storage.upload(key, body, "text/plain");

    const url = await storage.presignedUrl(key);
    expect(url).toContain(bucket);
    expect(url).toContain("presigned");

    const response = await fetch(url);
    expect(response.ok).toBe(true);
    const fetched = Buffer.from(await response.arrayBuffer());
    expect(fetched.equals(body)).toBe(true);
  });
});
