# @lyzr/cloudrift

Cloud-agnostic abstraction for **storage**, **messaging**, **document databases**, **cache**, **secrets**, and **pub/sub** — the TypeScript port of [`cloudrift`](../cloudrift-py), built for Lyzr microservices.

- **Async-first.** Every public method returns a `Promise`. All backends use native-async SDK clients (`@aws-sdk/*`, `@azure/*`, `mongodb`, `ioredis`) — no thread-pool wrapping.
- **Drop-in providers.** Same interface across AWS, Azure, and self-hosted backends. Swap `s3` ↔ `azure_blob` (or `sqs` ↔ `azure_service_bus`, `documentdb` ↔ `cosmos`, `redis` ↔ `elasticache` ↔ `azure_redis`) by changing one string.
- **Multiple auth methods per provider.** Static keys, IAM roles, profiles, managed identity, service principals, SAS tokens, mTLS, IAM auth — pick what your service already has.
- **Lazy, optional SDKs.** Provider SDKs are optional peer dependencies, dynamically imported only when you construct a backend that needs them. Install only what you use.

| Category    | AWS             | Azure                   | Self-hosted |
| ----------- | --------------- | ----------------------- | ----------- |
| Storage     | S3              | Blob Storage            | —           |
| Messaging   | SQS             | Service Bus             | —           |
| Document DB | DocumentDB      | Cosmos DB (MongoDB API) | —           |
| Cache       | ElastiCache     | Azure Cache for Redis   | Redis       |
| Secrets     | Secrets Manager | Key Vault               | —           |
| Pub/Sub     | SNS             | Event Grid              | —           |

Node 20+. ESM and CommonJS builds are both shipped.

---

## Install

```bash
npm i @lyzr/cloudrift
```

The provider SDKs are **optional peer dependencies** — `@lyzr/cloudrift` itself pulls in none of them. Install only the ones for the backends you actually use:

```bash
# Storage
npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @aws-sdk/credential-providers   # S3
npm i @azure/storage-blob @azure/identity                                              # Azure Blob

# Messaging
npm i @aws-sdk/client-sqs @aws-sdk/credential-providers     # SQS
npm i @azure/service-bus @azure/identity                    # Azure Service Bus

# Document DB (both providers use the same driver)
npm i mongodb                                               # DocumentDB & Cosmos

# Cache (one client for all three flavours)
npm i ioredis                                               # Redis / ElastiCache / Azure Redis
npm i @aws-sdk/credential-providers                         # + ElastiCache IAM auth
npm i @azure/identity                                       # + Azure Redis Entra auth

# Secrets
npm i @aws-sdk/client-secrets-manager @aws-sdk/credential-providers   # Secrets Manager
npm i @azure/keyvault-secrets @azure/identity                         # Key Vault

# Pub/Sub
npm i @aws-sdk/client-sns @aws-sdk/credential-providers     # SNS
npm i @azure/eventgrid @azure/identity                      # Event Grid
```

If you call a factory for a provider whose SDK is missing, you get a clear
`CloudRiftError` naming the package to install.

---

## Quick start

Construct each backend once via a factory function and hold it for the lifetime of
the service. Reuse one instance per resource — the underlying client is
connection-pooled.

```ts
import { getStorage } from "@lyzr/cloudrift/storage";
// or: import { getStorage } from "@lyzr/cloudrift";

// Construct once at startup
const storage = await getStorage("s3", {
  bucket: "my-bucket",
  awsAccessKeyId: "AKIA...",
  awsSecretAccessKey: "...",
  region: "us-east-1",
});

// Use anywhere
await storage.upload("docs/hello.txt", Buffer.from("hello world"), "text/plain");
const data: Buffer = await storage.download("docs/hello.txt");
const url = await storage.presignedUrl("docs/hello.txt", 3600);

// Release sockets at shutdown
await storage.close();
```

Or with `await using` for automatic disposal (every backend implements
`Symbol.asyncDispose`):

```ts
await using storage = await getStorage("s3", { bucket: "b", region: "us-east-1" });
await storage.upload("k", Buffer.from("v"));
// storage.close() runs automatically at the end of scope
```

Every factory is `async` (the SDK is imported lazily on construction). Imports work
from the root entry (`@lyzr/cloudrift`) or per-domain subpaths
(`@lyzr/cloudrift/storage`, `/messaging`, `/cache`, `/secrets`, `/pubsub`,
`/document`, `/core`).

---

## Storage

```ts
import { getStorage } from "@lyzr/cloudrift/storage";

// AWS S3
const s3 = await getStorage("s3", { bucket: "b", region: "us-east-1" }); // IAM role
const s3k = await getStorage("s3", {
  bucket: "b",
  awsAccessKeyId: "...", // static keys
  awsSecretAccessKey: "...",
  region: "us-east-1",
});
const s3p = await getStorage("s3", { bucket: "b", profileName: "dev" }); // ~/.aws/credentials

// Azure Blob
const blob = await getStorage("azure_blob", { connectionString: "...", container: "c" });
const blobK = await getStorage("azure_blob", {
  accountUrl: "https://acct.blob.core.windows.net",
  accountKey: "...",
  container: "c",
});
const blobS = await getStorage("azure_blob", {
  accountUrl: "...",
  sasToken: "...",
  container: "c",
});
const blobMI = await getStorage("azure_blob", { accountUrl: "...", container: "c" }); // managed identity
const blobSP = await getStorage("azure_blob", {
  accountUrl: "...",
  container: "c",
  tenantId: "...",
  clientId: "...",
  clientSecret: "...",
}); // service principal
```

**Operations** — identical on every backend:

```ts
await storage.upload(key, data, "application/json");
const data: Buffer = await storage.download(key);
await storage.delete(key);
const exists: boolean = await storage.exists(key);
const keys: string[] = await storage.list("logs/");
for await (const k of storage.listIter("logs/")) {
  /* streamed keys */
}
const url: string = await storage.presignedUrl(key, 3600);
await storage.copy(srcKey, dstKey /*, dstBucket */);
await storage.move(srcKey, dstKey);
const meta = await storage.getMetadata(key); // { contentType, size, lastModified, etag, metadata }
await storage.close();
```

`getStorageClient("s3", opts)` returns an account-scoped client whose `.bucket(name)`
returns a backend view sharing the same connection pool. Closing a view does not tear
down the shared pool; close the client to release it.

---

## Messaging

```ts
import { getQueue } from "@lyzr/cloudrift/messaging";

// AWS SQS
const sqs = await getQueue("sqs", {
  queueUrl: "https://sqs.us-east-1.amazonaws.com/.../q",
  region: "us-east-1",
});

// Azure Service Bus
const bus = await getQueue("azure_service_bus", { connectionString: "...", queueName: "my-queue" });
const busMI = await getQueue("azure_service_bus", {
  fullyQualifiedNamespace: "ns.servicebus.windows.net",
  queueName: "my-queue",
}); // managed identity
```

**Operations**:

```ts
const id = await queue.send({ action: "process", id: 42 }, /* delay */ 0);
const ids = await queue.sendBatch([{ n: 1 }, { n: 2 }]);

const messages = await queue.receive(/* maxMessages */ 10, /* waitTime */ 20); // long-poll
for (const m of messages) {
  handleJob(m.body);
  await queue.delete(m.receiptHandle); // ack
}

await queue.purge();
await queue.close();
```

> **Service Bus ack note.** SQS receipt handles are stateless tokens that any client
> can delete, so SQS `delete()` is a pure server call. Service Bus settlement is bound
> to the _exact_ receiver object that peek-locked the message. To present the same
> `receive()` / `delete(receiptHandle)` contract, the Service Bus backend uses each
> message's **lock token** as the `receiptHandle` and tracks a `lockToken →
{ receiver, message }` map, completing the message on its owning receiver and closing
> that receiver once its last token is acked. Consequences vs. SQS: a `receiptHandle` is
> only meaningful **inside the process that received it**, the lock can expire, and
> abandoned (never-deleted) messages keep their receiver open until `close()`. (This
> differs from the Python port, where `delete()` on Service Bus raises
> `NotImplementedError`; the TS port implements settlement instead.)

---

## Document Database

`getMongodb(...)` returns a configured native [`mongodb`](https://www.npmjs.com/package/mongodb)
`MongoClient`. Both providers speak the MongoDB wire protocol — AWS DocumentDB
natively, Azure Cosmos via its MongoDB-API endpoint — so you use the driver's API
directly. **No wrappers**: bulk writes, aggregations, change streams, transactions,
GridFS are all available.

```ts
import { getMongodb } from "@lyzr/cloudrift/document";

// AWS DocumentDB (MongoDB-compatible)
const client = await getMongodb("documentdb", {
  uri: "mongodb://user:pass@cluster.docdb.amazonaws.com:27017/?tls=true",
  tlsCaFile: "/etc/ssl/rds-ca-bundle.pem",
  maxPoolSize: 200,
});
// or build the URI from parts (credentials are quote_plus-encoded, matching cloudrift-py):
const c2 = await getMongodb("documentdb", {
  host: "cluster.docdb.amazonaws.com",
  port: 27017,
  username: "admin",
  password: "p@ss word",
});

// Azure Cosmos DB (MongoDB API) — keys only (Cosmos for Mongo/RU rejects AAD tokens)
const cosmos = await getMongodb("cosmos", { connectionString: "mongodb://..." });
const cosmosK = await getMongodb("cosmos", { account: "myacct", accountKey: "..." });

const db = client.db("lyzr");
const users = db.collection("users");
const { insertedId } = await users.insertOne({ name: "Alice", age: 30 });
const doc = await users.findOne({ name: "Alice" });

await client.close();
```

> **Errors here are native.** Operation errors propagate as native `mongodb` driver
> errors (e.g. `MongoServerError`, duplicate-key errors) — they are **not** mapped to
> the CloudRift tree. Only connect-time / URI-construction failures surface as
> `DocumentConnectionError`.

---

## Cache

`getCache(provider, authMethod, options)` — note the explicit two-arg dispatch.

```ts
import { getCache } from "@lyzr/cloudrift/cache";

// Self-hosted Redis
const cache = await getCache("redis", "from_url", { url: "redis://localhost:6379/0" });
const cred = await getCache("redis", "from_credentials", {
  host: "redis.internal",
  port: 6379,
  password: "...",
  db: 0,
});

// AWS ElastiCache
const ec = await getCache("elasticache", "from_auth_token", {
  host: "my-cluster.cache.amazonaws.com",
  authToken: "...",
});
const ecIam = await getCache("elasticache", "from_iam_auth", {
  host: "my-cluster.cache.amazonaws.com",
  username: "lyzr-app",
  region: "us-east-1",
}); // SigV4 + auto-refresh on reconnect

// Azure Cache for Redis
const az = await getCache("azure_redis", "from_access_key", {
  host: "my-cache.redis.cache.windows.net",
  accessKey: "...",
});
const azMI = await getCache("azure_redis", "from_managed_identity", {
  host: "my-cache.redis.cache.windows.net",
  username: "lyzr-app",
}); // Entra token
```

**Operations** — KV, hash, list, counters, pipeline:

```ts
await cache.set("session:abc", "data", 3600);
const value: Buffer | null = await cache.get("session:abc"); // Buffer, not string — see below
await cache.delete("session:abc");

await cache.hset("user:1", "name", "Alice");
const fields: Record<string, Buffer> = await cache.hgetall("user:1");

await cache.lpush("jobs", "job-1", "job-2");
const batch: Buffer[] = await cache.lrange("jobs", 0, 99);

const count = await cache.incr("hits:home");
const ok = await cache.ping();

const pipe = cache.pipeline();
pipe.set("a", "1").incr("a").get("a");
const results = await pipe.exec();

await cache.close();
```

> **Buffer return values.** Read methods (`get`, `mget`, `hget`, `hgetall`, `lrange`)
> return `Buffer` (or `Buffer | null`), the TS analog of Python's `bytes`. Decode with
> `value?.toString("utf-8")` when you need a string. `hgetall` returns
> `Record<string, Buffer>` — field **names** are decoded to JS strings (values stay as
> Buffers).

---

## Secrets

```ts
import { getSecrets } from "@lyzr/cloudrift/secrets";

// AWS Secrets Manager
const sm = await getSecrets("aws_secrets_manager", { region: "us-east-1" }); // IAM role
const smK = await getSecrets("aws_secrets_manager", {
  awsAccessKeyId: "...",
  awsSecretAccessKey: "...",
  region: "us-east-1",
});

// Azure Key Vault
const kv = await getSecrets("azure_keyvault", { vaultUrl: "https://v.vault.azure.net" }); // managed identity
const kvSP = await getSecrets("azure_keyvault", {
  vaultUrl: "https://v.vault.azure.net",
  tenantId: "...",
  clientId: "...",
  clientSecret: "...",
});

const value = await sm.getSecret("db/password");
const obj = await sm.getSecretJson("db/config"); // getSecret + JSON.parse
await sm.setSecret("db/password", "new-value"); // creates the secret if absent (AWS)
await sm.deleteSecret("db/password");
const names = await sm.listSecrets("db/");
await sm.close();
```

---

## Pub/Sub

```ts
import { getPubsub } from "@lyzr/cloudrift/pubsub";

// AWS SNS
const sns = await getPubsub("sns", { region: "us-east-1" });

// Azure Event Grid
const eg = await getPubsub("azure_eventgrid", {
  endpoint: "https://t.region.eventgrid.azure.net/api/events",
  accessKey: "...",
});

const id = await sns.publish("arn:aws:sns:...:topic", "hello", { trace: "abc" });
const ids = await sns.publishBatch("arn:aws:sns:...:topic", [
  { message: "a" },
  { message: "b", attributes: { k: "v" } },
]); // SNS chunks at 10 per request
await sns.close();
```

---

## Connection pooling & lifecycle

Every backend holds **one long-lived client** reused across all operations. This is
the single biggest perf knob:

- **Don't** call a `get*(...)` factory inside a request handler.
- **Do** construct once at startup and share it (module singleton, DI container, etc.).

AWS pool sizes / timeouts are configurable per backend and default to the same values
as the Python port (S3 `maxPoolConnections=50`, `connectTimeout=10s`, `readTimeout=60s`;
SQS the same; Secrets Manager pool `25`, read `30s`):

```ts
await getStorage("s3", {
  bucket: "b",
  region: "us-east-1",
  maxPoolConnections: 100,
  connectTimeout: 5,
  readTimeout: 30,
});

await getMongodb("documentdb", { uri: "...", maxPoolSize: 200, minPoolSize: 10 });
```

Always release sockets on shutdown with `await backend.close()` — or use `await using`
to close automatically at end of scope. Every backend implements both `close()` and
`Symbol.asyncDispose`.

---

## Errors

All backends (except the document layer, by design) raise from a single hierarchy,
re-exported from the root and `@lyzr/cloudrift/core`. Every translated error carries the
original SDK error as its `cause`.

```
CloudRiftError
├── StorageError
│   ├── ObjectNotFoundError
│   └── StoragePermissionError
├── MessagingError
│   ├── QueueNotFoundError
│   └── MessageSendError
├── DocumentConnectionError
├── CacheError
│   ├── CacheConnectionError
│   └── CacheKeyNotFoundError
├── SecretError
│   ├── SecretNotFoundError
│   └── SecretPermissionError
└── PubSubError
    ├── TopicNotFoundError
    └── PublishError
```

```ts
import { ObjectNotFoundError } from "@lyzr/cloudrift";

try {
  await storage.download("missing.txt");
} catch (err) {
  if (err instanceof ObjectNotFoundError) {
    /* ... */
  }
}
```

Provider-specific exceptions (`@aws-sdk` service errors, `@azure/core` `RestError`,
ioredis errors) are translated at the adapter boundary. **The document layer is the
exception:** `getMongodb(...)` returns a native `MongoClient` and operation errors
propagate as native `mongodb` errors; only connect-time failures surface as
`DocumentConnectionError`.

---

## Provider / auth matrix

| Domain    | Provider string       | Auth methods (inferred from option keys, except cache)                                                      |
| --------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Storage   | `s3`                  | `awsAccessKeyId` → access key · `profileName` → profile · else IAM role                                     |
| Storage   | `azure_blob`          | `connectionString` · `accountKey` · `sasToken` · `clientSecret` → service principal · else managed identity |
| Messaging | `sqs`                 | `awsAccessKeyId` · `profileName` · else IAM role                                                            |
| Messaging | `azure_service_bus`   | `connectionString` · `clientSecret` → service principal · else managed identity                             |
| Secrets   | `aws_secrets_manager` | `awsAccessKeyId` · `profileName` · else IAM role                                                            |
| Secrets   | `azure_keyvault`      | `clientSecret` → service principal · else managed identity                                                  |
| Pub/Sub   | `sns`                 | `awsAccessKeyId` · `profileName` · else IAM role                                                            |
| Pub/Sub   | `azure_eventgrid`     | `accessKey` · `clientSecret` → service principal · else managed identity                                    |
| Document  | `documentdb`          | `uri` · `tlsCertKeyFile` → mTLS · else credentials                                                          |
| Document  | `cosmos`              | `connectionString` · `accountKey`                                                                           |
| Cache     | `redis`               | `from_url` · `from_credentials` · `from_tls_cert`                                                           |
| Cache     | `elasticache`         | `from_auth_token` · `from_iam_auth` · `from_tls_cert`                                                       |
| Cache     | `azure_redis`         | `from_access_key` · `from_managed_identity` · `from_service_principal`                                      |

Cache uses an explicit `authMethod` argument (snake_case config strings); all other
domains infer the auth method from which option keys you pass, with the precedence shown
above. An unknown provider or cache auth method throws `CloudRiftError`.

---

## Relationship to `cloudrift-py`

This is a behavioral port of the Python [`cloudrift`](../cloudrift-py) package. Semantics
follow the Python source of record; see `docs/ARCHITECTURE.md` for the normative type
API and `docs/PORTING_PLAN.md` §7 for the small set of intentional divergences (error
type for unmapped non-SDK failures, `Buffer` vs `bytes`, cache empty-varargs guards, and
the Service Bus `delete()` implementation noted above).
