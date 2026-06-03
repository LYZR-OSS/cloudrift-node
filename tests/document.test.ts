import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DocumentConnectionError } from "../src/core/errors.js";
import {
  getMongodb,
  setCosmosClientConstructor,
  setDocumentDbClientConstructor,
} from "../src/document/index.js";

/** Stand-in for MongoClient that records constructor args. */
class RecordingClient {
  static instances: RecordingClient[] = [];
  uri: string;
  options: Record<string, unknown>;

  constructor(uri: string, options?: Record<string, unknown>) {
    this.uri = uri;
    this.options = options ?? {};
    RecordingClient.instances.push(this);
  }

  async close(): Promise<void> {
    /* no-op */
  }
}

function last(): RecordingClient {
  const inst = RecordingClient.instances.at(-1);
  if (!inst) {
    throw new Error("no RecordingClient was constructed");
  }
  return inst;
}

beforeEach(() => {
  RecordingClient.instances = [];
  setDocumentDbClientConstructor(RecordingClient as never);
  setCosmosClientConstructor(RecordingClient as never);
});

afterEach(() => {
  setDocumentDbClientConstructor(undefined);
  setCosmosClientConstructor(undefined);
});

describe("documentdb", () => {
  it("uri: passes pool kwargs and tlsCAFile", async () => {
    await getMongodb("documentdb", {
      uri: "mongodb://h:27017/",
      maxPoolSize: 200,
      minPoolSize: 10,
      tlsCaFile: "/etc/ssl/ca.pem",
    });
    const inst = last();
    expect(inst.uri).toBe("mongodb://h:27017/");
    expect(inst.options.maxPoolSize).toBe(200);
    expect(inst.options.minPoolSize).toBe(10);
    expect(inst.options.tlsCAFile).toBe("/etc/ssl/ca.pem");
  });

  it("uri: passes through extra client options", async () => {
    await getMongodb("documentdb", {
      uri: "mongodb://h/",
      directConnection: true,
    });
    const inst = last();
    expect(inst.options.directConnection).toBe(true);
  });

  it("credentials: URL-encodes special-char password", async () => {
    await getMongodb("documentdb", {
      host: "cluster.docdb.amazonaws.com",
      port: 27017,
      username: "admin",
      password: "p@ss/word",
      tls: true,
    });
    const inst = last();
    expect(inst.uri).toContain("p%40ss%2Fword");
    expect(inst.uri.startsWith("mongodb://admin:")).toBe(true);
    expect(inst.uri).toContain("cluster.docdb.amazonaws.com:27017");
    expect(inst.options.tls).toBe(true);
  });

  it("credentials: defaults tls true", async () => {
    await getMongodb("documentdb", {
      host: "h",
      port: 27017,
      username: "u",
      password: "p",
    });
    expect(last().options.tls).toBe(true);
  });

  it("tlsCert: passes cert path and CA path, tls true", async () => {
    await getMongodb("documentdb", {
      host: "cluster.docdb.amazonaws.com",
      port: 27017,
      username: "admin",
      password: "pw",
      tlsCertKeyFile: "/secrets/client.pem",
      tlsCaFile: "/secrets/ca.pem",
    });
    const inst = last();
    expect(inst.options.tls).toBe(true);
    expect(inst.options.tlsCertificateKeyFile).toBe("/secrets/client.pem");
    expect(inst.options.tlsCAFile).toBe("/secrets/ca.pem");
  });

  const docCases: Array<[Record<string, unknown>, number, number]> = [
    [{ uri: "mongodb://h/" }, 100, 0],
    [{ host: "h", port: 27017, username: "u", password: "p" }, 100, 0],
    [
      {
        host: "h",
        port: 27017,
        username: "u",
        password: "p",
        tlsCertKeyFile: "/c.pem",
      },
      100,
      0,
    ],
    [{ uri: "mongodb://h/", maxPoolSize: 250, minPoolSize: 25 }, 250, 25],
    [
      {
        host: "h",
        port: 27017,
        username: "u",
        password: "p",
        maxPoolSize: 250,
        minPoolSize: 25,
      },
      250,
      25,
    ],
    [
      {
        host: "h",
        port: 27017,
        username: "u",
        password: "p",
        tlsCertKeyFile: "/c.pem",
        maxPoolSize: 250,
        minPoolSize: 25,
      },
      250,
      25,
    ],
  ];

  it.each(docCases)(
    "pool kwargs standardized: %o",
    async (opts, expectedMax, expectedMin) => {
      await getMongodb("documentdb", opts);
      const inst = last();
      expect(inst.options.maxPoolSize).toBe(expectedMax);
      expect(inst.options.minPoolSize).toBe(expectedMin);
    },
  );

  it("dispatch routes uri before credentials/tlsCert", async () => {
    await getMongodb("documentdb", {
      uri: "mongodb://h/",
      tlsCertKeyFile: "/c.pem",
      host: "h",
    });
    expect(last().uri).toBe("mongodb://h/");
  });
});

describe("cosmos", () => {
  it("accountKey: builds exact mongo URI and encodes key", async () => {
    await getMongodb("cosmos", {
      account: "myacct",
      accountKey: "raw+key/with=special",
    });
    const uri = last().uri;
    expect(uri.startsWith("mongodb://myacct:")).toBe(true);
    expect(uri).toContain("myacct.mongo.cosmos.azure.com:10255");
    expect(uri).toContain("ssl=true");
    expect(uri).toContain("replicaSet=globaldb");
    expect(uri).toContain("retryWrites=false");
    expect(uri).toContain("maxIdleTimeMS=120000");
    expect(uri).toContain("raw%2Bkey%2Fwith%3Dspecial");
  });

  it("accountKey: exact full URI shape with default appName", async () => {
    await getMongodb("cosmos", { account: "acct", accountKey: "k" });
    expect(last().uri).toBe(
      "mongodb://acct:k@acct.mongo.cosmos.azure.com:10255/" +
        "?ssl=true&replicaSet=globaldb&retryWrites=false" +
        "&maxIdleTimeMS=120000&appName=%40acct%40",
    );
  });

  it("connectionString: passed through verbatim", async () => {
    const cs =
      "mongodb://acct:key@acct.mongo.cosmos.azure.com:10255/?ssl=true";
    await getMongodb("cosmos", { connectionString: cs });
    expect(last().uri).toBe(cs);
  });

  const cosmosCases: Array<[Record<string, unknown>, number, number]> = [
    [{ connectionString: "mongodb://h/" }, 100, 0],
    [{ account: "a", accountKey: "k" }, 100, 0],
    [
      { connectionString: "mongodb://h/", maxPoolSize: 250, minPoolSize: 25 },
      250,
      25,
    ],
    [
      { account: "a", accountKey: "k", maxPoolSize: 250, minPoolSize: 25 },
      250,
      25,
    ],
  ];

  it.each(cosmosCases)(
    "pool kwargs standardized: %o",
    async (opts, expectedMax, expectedMin) => {
      await getMongodb("cosmos", opts);
      const inst = last();
      expect(inst.options.maxPoolSize).toBe(expectedMax);
      expect(inst.options.minPoolSize).toBe(expectedMin);
    },
  );
});

describe("dispatch + errors", () => {
  it("unknown provider throws CloudRiftError", async () => {
    await expect(
      getMongodb("dynamodb" as never, { uri: "x" }),
    ).rejects.toThrow(/Unknown document DB provider/);
  });

  it("documentdb construction failure wrapped in DocumentConnectionError", async () => {
    setDocumentDbClientConstructor(
      class {
        constructor() {
          throw new Error("bad uri");
        }
      } as never,
    );
    await expect(
      getMongodb("documentdb", { uri: "mongodb://broken" }),
    ).rejects.toBeInstanceOf(DocumentConnectionError);
    await expect(
      getMongodb("documentdb", { uri: "mongodb://broken" }),
    ).rejects.toThrow(/Failed to connect to DocumentDB/);
  });

  it("cosmos construction failure wrapped in DocumentConnectionError", async () => {
    setCosmosClientConstructor(
      class {
        constructor() {
          throw new Error("bad key");
        }
      } as never,
    );
    await expect(
      getMongodb("cosmos", { account: "a", accountKey: "k" }),
    ).rejects.toThrow(/Failed to connect to Cosmos DB/);
  });
});
