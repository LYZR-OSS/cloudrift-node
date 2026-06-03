# cloudrift-ts Architecture: Call Graphs, Seams, Type APIs

This is the implementation spec for the TypeScript port. Signatures here are
normative — module implementations must match them exactly. Semantics follow
`cloudrift-py` (see `../../cloudrift-py/cloudrift/` for behavior of record).

## 1. Package layout

```
cloudrift-ts/
├── package.json            # @lyzr/cloudrift — ESM+CJS, subpath exports, optional peer deps
├── tsconfig.json           # strict, NodeNext
├── tsup.config.ts
├── vitest.config.ts
├── src/
│   ├── index.ts            # re-exports all factories, backends, errors, types
│   ├── core/
│   │   ├── index.ts
│   │   ├── errors.ts       # full CloudRiftError tree
│   │   └── lazy.ts         # requireOptional(pkg, provider) helper
│   ├── storage/
│   │   ├── index.ts        # getStorage(), getStorageClient()
│   │   ├── base.ts         # abstract StorageBackend, ObjectMetadata
│   │   ├── s3.ts           # AWSS3Client, AWSS3Backend
│   │   └── azureBlob.ts    # AzureBlobClient, AzureBlobBackend
│   ├── messaging/
│   │   ├── index.ts        # getQueue()
│   │   ├── base.ts         # Message, abstract MessagingBackend
│   │   ├── sqs.ts          # AWSSQSBackend
│   │   └── azureBus.ts     # AzureServiceBusBackend
│   ├── document/
│   │   ├── index.ts        # getMongodb()
│   │   ├── documentdb.ts   # connectUri / connectCredentials / connectTlsCert
│   │   └── cosmos.ts       # connectConnectionString / connectAccountKey
│   ├── cache/
│   │   ├── index.ts        # getCache()
│   │   ├── base.ts         # abstract CacheBackend
│   │   ├── redisBase.ts    # BaseRedisBackend (ioredis impl of all ops)
│   │   ├── redisStandalone.ts
│   │   ├── redisElasticache.ts   # + SigV4 IAM token generator
│   │   └── redisAzure.ts         # + Entra token provider
│   ├── secrets/
│   │   ├── index.ts        # getSecrets()
│   │   ├── base.ts         # abstract SecretBackend
│   │   ├── awsSecretsManager.ts
│   │   └── azureKeyvault.ts
│   └── pubsub/
│       ├── index.ts        # getPubsub()
│       ├── base.ts         # abstract PubSubBackend, PubSubMessage
│       ├── sns.ts          # AWSSNSBackend
│       └── azureEventgrid.ts
└── tests/
    ├── cache.test.ts
    ├── storage.test.ts
    ├── messaging.test.ts
    ├── secrets.test.ts
    ├── pubsub.test.ts
    └── document.test.ts
```

## 2. Seams (abstraction boundaries)

Providers plug in at exactly three seams per domain:

1. **Abstract base class** (`base.ts`) — the contract. Concrete default methods live
   here (`move`, `healthCheck`, `listIter`, `setex`, async-dispose). Contract tests run
   against this surface.
2. **Static factory constructors** on each provider class (`fromAccessKey`,
   `fromIamRole`, `fromProfile`, `fromConnectionString`, `fromAccountKey`,
   `fromSasToken`, `fromManagedIdentity`, `fromServicePrincipal`, `fromUrl`,
   `fromCredentials`, `fromTlsCert`, `fromAuthToken`, `fromIamAuth`) — where credentials
   become SDK clients. SDK packages are loaded lazily here via `core/lazy.ts`.
3. **Module factory function** (`index.ts`) — string-dispatched provider selection +
   auth-method inference from option keys. This is the only API most services use.

Cross-cutting seams:

- **Error translation boundary**: every provider adapter catches SDK errors and rethrows
  from the `core/errors.ts` tree with `{ cause: originalError }`. Nothing above the
  adapter ever sees an SDK error type (document module operations excepted, by design).
- **Lazy client init (AWS)**: adapters hold config; the SDK client is created on first
  use behind a promise-memoized `ensure()` (equivalent of Python's asyncio.Lock guard).
- **Client/Backend split (storage)**: account-scoped client owns the pool; bucket views
  share it. `ownsClient` controls whether `close()` tears down the pool.
- **Lifecycle**: every backend has `close(): Promise<void>` and
  `[Symbol.asyncDispose]()` delegating to it.

## 3. Call graphs

### 3.1 Factory dispatch (all domains share this shape)

```
getStorage("s3", opts)
 ├─ opts.awsAccessKeyId?   → AWSS3Backend.fromAccessKey(opts)
 ├─ opts.profileName?      → AWSS3Backend.fromProfile(opts)
 └─ else                   → AWSS3Backend.fromIamRole(opts)
getStorage("azure_blob", opts)
 ├─ opts.connectionString? → AzureBlobBackend.fromConnectionString(opts)
 ├─ opts.accountKey?       → AzureBlobBackend.fromAccountKey(opts)
 ├─ opts.sasToken?         → AzureBlobBackend.fromSasToken(opts)
 ├─ opts.clientSecret?     → AzureBlobBackend.fromServicePrincipal(opts)
 └─ else                   → AzureBlobBackend.fromManagedIdentity(opts)
getStorage(other)          → throws CloudRiftError("unknown provider ...")
```

Same precedence pattern for:
- `getQueue`: `sqs` (accessKey | profile | iamRole), `azure_service_bus`
  (connectionString | clientSecret→servicePrincipal | managedIdentity)
- `getSecrets`: `aws_secrets_manager` (accessKey | profile | iamRole),
  `azure_keyvault` (clientSecret→servicePrincipal | managedIdentity)
- `getPubsub`: `sns` (accessKey | profile | iamRole), `azure_eventgrid`
  (accessKey | clientSecret→servicePrincipal | managedIdentity)
- `getMongodb`: `documentdb` (uri | tlsCertKeyFile→tlsCert | credentials),
  `cosmos` (connectionString | accountKey)
- `getCache(provider, authMethod, opts)`: explicit two-arg dispatch —
  `redis`: `from_url` | `from_credentials` | `from_tls_cert`;
  `elasticache`: `from_auth_token` | `from_iam_auth` | `from_tls_cert`;
  `azure_redis`: `from_access_key` | `from_managed_identity` | `from_service_principal`.
  `authMethod` strings keep the Python snake_case names (they are config values, mapped
  internally to the camelCase static constructors). Unknown provider/method → `CloudRiftError`.

### 3.2 Storage (S3 path)

```
getStorage("s3", o) → AWSS3Backend.fromAccessKey
                        └─ new AWSS3Client(credentials, region, pool/timeout cfg)
                        └─ new AWSS3Backend(bucket, client, ownsClient=true)
backend.upload(key, data, ct)
  └─ client.ensure()                # memoized: lazy-create S3Client on first call
  └─ s3.send(PutObjectCommand)      # error → mapS3Error → StorageError tree
backend.download → GetObjectCommand → body → Buffer
backend.exists   → HeadObjectCommand (404/NotFound → false)
backend.list     → paginate ListObjectsV2Command (collect)   backend.listIter → yield per page
backend.presignedUrl → getSignedUrl(s3, GetObjectCommand, {expiresIn})
backend.copy     → CopyObjectCommand {CopySource: srcBucket/srcKey} (dstBucket ?? own bucket)
backend.move     → base default: copy() then delete()
backend.getMetadata → HeadObjectCommand → ObjectMetadata
backend.uploadStream → collect chunks → upload()             # parity with py
backend.close    → ownsClient ? client.close() : no-op

getStorageClient("s3", o) → AWSS3Client; client.bucket(name) → AWSS3Backend(ownsClient=false)
```

### 3.3 Storage (Azure Blob path)

```
AzureBlobClient.fromConnectionString
  └─ BlobServiceClient.fromConnectionString; accountKey parsed from conn string
backend.upload        → containerClient.getBlockBlobClient(key).upload(data, len, {blobHTTPHeaders})
backend.presignedUrl  → requires accountKey → generateBlobSASQueryParameters (read, expiry) → URL
backend.copy          → dstBlob.beginCopyFromURL(srcBlob.url) → pollUntilDone
backend.uploadStream  → blockBlobClient.uploadStream(Readable.from(stream))   # true streaming
errors: RestError 404 → ObjectNotFoundError; 403 → StoragePermissionError; else StorageError
```

### 3.4 Messaging

```
SQS:  send       → SendMessageCommand {MessageBody: JSON.stringify(body), DelaySeconds}
      sendBatch  → SendMessageBatchCommand; any Failed entry → MessageSendError
      receive    → ReceiveMessageCommand {MaxNumberOfMessages, WaitTimeSeconds}
                   → Message{id, body: JSON.parse, receiptHandle, attributes}
      delete     → DeleteMessageCommand {ReceiptHandle}
      purge      → PurgeQueueCommand
      healthCheck→ GetQueueAttributesCommand ["QueueArn"]
      errors: NonExistentQueue → QueueNotFoundError; send fail → MessageSendError; else MessagingError

ServiceBus: one ServiceBusClient (AMQP) per backend
      send       → sender.sendMessages(ServiceBusMessage) | scheduleMessages when delay>0
      receive    → receiver.receiveMessages({maxMessageCount, maxWaitTimeInMs})
                   each msg tracked: pending.set(lockToken, {receiver, msg}); receiverTokens counts
      delete(rh) → lookup pending → receiver.completeMessage(msg);
                   close receiver when its last token is removed
      purge      → loop receive(100)+complete until empty
      healthCheck→ create+close a sender
```

### 3.5 Cache

```
getCache("elasticache", "from_iam_auth", o)
  └─ AWSElastiCacheBackend.fromIamAuth
       └─ generateElastiCacheIamToken(host, username, region, creds)  # SigV4 presigned URL, 15-min
       └─ new Redis(host, port, {username, password: token, tls, db})
       └─ reconnect hook regenerates token
All ops via BaseRedisBackend → ioredis:
  get→getBuffer  set→set(+EX ttl)  delete→del(...keys)  exists  expire  ttl
  keys(pattern)→string[]  hget→hgetBuffer  hset  hgetall→hgetallBuffer  hdel
  lpush rpush lrange→lrangeBuffer llen  incr decr  mget→mgetBuffer  mset
  ping flush→flushdb  pipeline()→ioredis multi (exec on dispose)
  every op: catch → throw CacheError(msg, {cause}); connect failures → CacheConnectionError
```

### 3.6 Secrets / PubSub / Document

```
Secrets AWS:  getSecret → GetSecretValueCommand → SecretString
              setSecret → PutSecretValueCommand, on ResourceNotFoundException → CreateSecretCommand
              deleteSecret → DeleteSecretCommand {ForceDeleteWithoutRecovery: true}
              listSecrets → paginate ListSecretsCommand (+ name filter when prefix)
Secrets AKV:  SecretClient(vaultUrl, credential); deleteSecret → beginDeleteSecret().pollUntilDone()
              listSecrets → for-await listPropertiesOfSecrets, filter startsWith(prefix)

PubSub SNS:   publish → PublishCommand {TopicArn, Message, MessageAttributes{String}}
              publishBatch → chunk(10) → PublishBatchCommand; Failed → PublishError
PubSub EG:    publish → client.send([{type:"cloudrift.event", source: topic, id: uuid,
              data: message, ...attributes-as-extensions}]) (CloudEvent schema)

Document:     getMongodb → connect helper builds URI → new MongoClient(uri, {maxPoolSize, minPoolSize, ...})
              construction/URI errors → DocumentConnectionError; operations stay native
```

## 4. Type APIs (normative)

### 4.1 core/errors.ts

```ts
export class CloudRiftError extends Error {
  constructor(message: string, options?: { cause?: unknown });
}
export class StorageError extends CloudRiftError {}
export class ObjectNotFoundError extends StorageError {}
export class StoragePermissionError extends StorageError {}
export class MessagingError extends CloudRiftError {}
export class QueueNotFoundError extends MessagingError {}
export class MessageSendError extends MessagingError {}
export class DocumentConnectionError extends CloudRiftError {}
export class CacheError extends CloudRiftError {}
export class CacheConnectionError extends CacheError {}
export class CacheKeyNotFoundError extends CacheError {}
export class SecretError extends CloudRiftError {}
export class SecretNotFoundError extends SecretError {}
export class SecretPermissionError extends SecretError {}
export class PubSubError extends CloudRiftError {}
export class TopicNotFoundError extends PubSubError {}
export class PublishError extends PubSubError {}
```

All classes set `this.name` to the class name. `core/lazy.ts`:

```ts
/** Dynamic-import an optional peer dep; throws CloudRiftError naming the missing package. */
export async function loadOptional<T>(pkg: string, provider: string): Promise<T>;
```

### 4.2 storage

```ts
export type BinaryInput = Buffer | Uint8Array | string;

export interface ObjectMetadata {
  contentType: string | undefined;
  size: number;
  lastModified: Date | undefined;
  etag: string | undefined;
  metadata: Record<string, string>;
}

export abstract class StorageBackend {
  abstract upload(key: string, data: BinaryInput, contentType?: string): Promise<string>;
  abstract download(key: string): Promise<Buffer>;
  abstract delete(key: string): Promise<void>;
  abstract exists(key: string): Promise<boolean>;
  abstract list(prefix?: string): Promise<string[]>;
  listIter(prefix?: string): AsyncIterable<string>;            // default: wraps list()
  abstract presignedUrl(key: string, expiresIn?: number): Promise<string>; // default 3600
  abstract copy(srcKey: string, dstKey: string, dstBucket?: string): Promise<string>;
  move(srcKey: string, dstKey: string, dstBucket?: string): Promise<string>; // default copy+delete
  abstract getMetadata(key: string): Promise<ObjectMetadata>;
  abstract uploadStream(key: string, stream: AsyncIterable<Buffer | Uint8Array>,
                        contentType?: string): Promise<string>;
  healthCheck(): Promise<boolean>;          // default: exists("__cloudrift_health__"), catch→false
  close(): Promise<void>;                   // default no-op
  [Symbol.asyncDispose](): Promise<void>;   // → close()
}

export interface AwsClientOptions {
  endpointUrl?: string;
  maxPoolConnections?: number;   // S3 default 50 → maps to maxSockets/requestHandler cfg
  connectTimeout?: number;       // seconds (S3 default 10)
  readTimeout?: number;          // seconds (S3 default 60)
}
export interface AwsAccessKeyOptions extends AwsClientOptions {
  awsAccessKeyId: string; awsSecretAccessKey: string;
  awsSessionToken?: string; region?: string;          // default "us-east-1"
}
export interface AwsIamRoleOptions extends AwsClientOptions { region?: string; }
export interface AwsProfileOptions extends AwsClientOptions { profileName: string; region?: string; }

export class AWSS3Client {
  static fromAccessKey(opts: AwsAccessKeyOptions): AWSS3Client;
  static fromIamRole(opts?: AwsIamRoleOptions): AWSS3Client;
  static fromProfile(opts: AwsProfileOptions): AWSS3Client;
  bucket(name: string): AWSS3Backend;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
export class AWSS3Backend extends StorageBackend {
  constructor(bucket: string, client: AWSS3Client, ownsClient?: boolean);
  static fromAccessKey(opts: AwsAccessKeyOptions & { bucket: string }): AWSS3Backend;
  static fromIamRole(opts: AwsIamRoleOptions & { bucket: string }): AWSS3Backend;
  static fromProfile(opts: AwsProfileOptions & { bucket: string }): AWSS3Backend;
}

export class AzureBlobClient {
  static fromConnectionString(opts: { connectionString: string }): AzureBlobClient;
  static fromAccountKey(opts: { accountUrl: string; accountKey: string }): AzureBlobClient;
  static fromSasToken(opts: { accountUrl: string; sasToken: string }): AzureBlobClient;
  static fromManagedIdentity(opts: { accountUrl: string; clientId?: string }): AzureBlobClient;
  static fromServicePrincipal(opts: { accountUrl: string; tenantId: string;
                                      clientId: string; clientSecret: string }): AzureBlobClient;
  container(name: string): AzureBlobBackend;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
export class AzureBlobBackend extends StorageBackend {
  constructor(container: string, client: AzureBlobClient, ownsClient?: boolean);
  // static from* mirrors of AzureBlobClient, each + { container: string }
}

export type StorageProvider = "s3" | "azure_blob";
export function getStorage(provider: StorageProvider,
                           options: Record<string, unknown>): Promise<StorageBackend>;
export function getStorageClient(provider: StorageProvider,
                                 options: Record<string, unknown>): Promise<AWSS3Client | AzureBlobClient>;
```

Factories are `async` (lazy SDK import). Static `from*` constructors that need an SDK
do the import inside `getStorage` / a private async init — implementers may make the
statics async (`Promise<AWSS3Client>`); the factory functions are the stable surface.

### 4.3 messaging

```ts
export interface Message {
  id: string;
  body: Record<string, unknown>;
  receiptHandle: string;
  attributes: Record<string, unknown>;
}

export abstract class MessagingBackend {
  abstract send(message: Record<string, unknown>, delay?: number): Promise<string>;
  abstract sendBatch(messages: Array<Record<string, unknown>>): Promise<string[]>;
  abstract receive(maxMessages?: number, waitTime?: number): Promise<Message[]>; // 1, 0
  abstract delete(receiptHandle: string): Promise<void>;
  abstract purge(): Promise<void>;
  healthCheck(): Promise<boolean>;   // default true
  close(): Promise<void>;            // default no-op
  [Symbol.asyncDispose](): Promise<void>;
}

export class AWSSQSBackend extends MessagingBackend {
  static fromAccessKey(opts: AwsAccessKeyOptions & { queueUrl: string }): AWSSQSBackend;
  static fromIamRole(opts: AwsIamRoleOptions & { queueUrl: string }): AWSSQSBackend;
  static fromProfile(opts: AwsProfileOptions & { queueUrl: string }): AWSSQSBackend;
}
export class AzureServiceBusBackend extends MessagingBackend {
  static fromConnectionString(opts: { connectionString: string; queueName: string }): AzureServiceBusBackend;
  static fromManagedIdentity(opts: { fullyQualifiedNamespace: string; queueName: string;
                                     clientId?: string }): AzureServiceBusBackend;
  static fromServicePrincipal(opts: { fullyQualifiedNamespace: string; queueName: string;
                                      tenantId: string; clientId: string;
                                      clientSecret: string }): AzureServiceBusBackend;
}

export type QueueProvider = "sqs" | "azure_service_bus";
export function getQueue(provider: QueueProvider,
                         options: Record<string, unknown>): Promise<MessagingBackend>;
```

### 4.4 document

```ts
import type { MongoClient } from "mongodb";

export interface PoolOptions { maxPoolSize?: number; minPoolSize?: number; } // 100, 0

// documentdb.ts
export function connectUri(opts: { uri: string; tlsCaFile?: string } & PoolOptions
                           & Record<string, unknown>): Promise<MongoClient>;
export function connectCredentials(opts: { host: string; port: number; username: string;
  password: string; tls?: boolean; tlsCaFile?: string } & PoolOptions): Promise<MongoClient>;
export function connectTlsCert(opts: { host: string; port: number; username: string;
  password: string; tlsCertKeyFile: string; tlsCaFile?: string } & PoolOptions): Promise<MongoClient>;

// cosmos.ts
export function connectConnectionString(opts: { connectionString: string } & PoolOptions): Promise<MongoClient>;
export function connectAccountKey(opts: { account: string; accountKey: string; port?: number;
  appName?: string } & PoolOptions): Promise<MongoClient>;  // port default 10255

export type DocumentProvider = "documentdb" | "cosmos";
export function getMongodb(provider: DocumentProvider,
                           options: Record<string, unknown>): Promise<MongoClient>;
```

Cosmos `connectAccountKey` URI: `mongodb://{account}:{key}@{account}.mongo.cosmos.azure.com:{port}/?ssl=true&replicaSet=globaldb&retryWrites=false&maxIdleTimeMS=120000&appName=@{account}@`.
`connectCredentials` must `encodeURIComponent` username/password.

### 4.5 cache

```ts
export type CacheValue = Buffer | string;

export abstract class CacheBackend {
  abstract get(key: string): Promise<Buffer | null>;
  abstract set(key: string, value: CacheValue, ttl?: number): Promise<void>;
  setex(key: string, value: CacheValue, ttl: number): Promise<void>;  // default → set
  abstract delete(...keys: string[]): Promise<number>;
  abstract exists(key: string): Promise<boolean>;
  abstract expire(key: string, seconds: number): Promise<boolean>;
  abstract ttl(key: string): Promise<number>;                          // -1 / -2 semantics
  abstract keys(pattern?: string): Promise<string[]>;                  // default "*"
  abstract hget(key: string, field: string): Promise<Buffer | null>;
  abstract hset(key: string, field: string, value: CacheValue): Promise<number>;
  abstract hgetall(key: string): Promise<Record<string, Buffer>>;
  abstract hdel(key: string, ...fields: string[]): Promise<number>;
  abstract lpush(key: string, ...values: CacheValue[]): Promise<number>;
  abstract rpush(key: string, ...values: CacheValue[]): Promise<number>;
  abstract lrange(key: string, start: number, stop: number): Promise<Buffer[]>;
  abstract llen(key: string): Promise<number>;
  abstract incr(key: string): Promise<number>;
  abstract decr(key: string): Promise<number>;
  abstract mget(...keys: string[]): Promise<Array<Buffer | null>>;
  abstract mset(mapping: Record<string, CacheValue>): Promise<void>;
  abstract ping(): Promise<boolean>;
  abstract flush(): Promise<void>;
  abstract close(): Promise<void>;
  healthCheck(): Promise<boolean>;          // default: ping(), catch → false
  abstract pipeline(): CachePipeline;       // ioredis ChainableCommander wrapper
  [Symbol.asyncDispose](): Promise<void>;
}
export interface CachePipeline {
  set(key: string, value: CacheValue, ttl?: number): this;
  get(key: string): this;
  delete(...keys: string[]): this;
  incr(key: string): this;
  exec(): Promise<unknown[]>;
}

export class StandaloneRedisBackend /* extends BaseRedisBackend extends CacheBackend */ {
  static fromUrl(opts: { url: string; sslCaCerts?: string }): Promise<StandaloneRedisBackend>;
  static fromCredentials(opts: { host: string; port?: number; password?: string; username?: string;
    db?: number; ssl?: boolean; sslCaCerts?: string }): Promise<StandaloneRedisBackend>;     // port 6379
  static fromTlsCert(opts: { host: string; port?: number; password?: string; username?: string;
    db?: number; sslCertfile: string; sslKeyfile: string; sslCaCerts?: string }): Promise<StandaloneRedisBackend>; // port 6380
}
export class AWSElastiCacheBackend {
  static fromAuthToken(opts: { host: string; port?: number; authToken?: string; db?: number;
    ssl?: boolean; sslCaCerts?: string }): Promise<AWSElastiCacheBackend>;                   // port 6379, ssl true
  static fromIamAuth(opts: { host: string; username: string; region: string; port?: number;
    db?: number; ssl?: boolean; sslCaCerts?: string; awsAccessKeyId?: string;
    awsSecretAccessKey?: string; awsSessionToken?: string; profileName?: string }): Promise<AWSElastiCacheBackend>;
  static fromTlsCert(opts: { host: string; port?: number; authToken?: string; db?: number;
    sslCertfile: string; sslKeyfile: string; sslCaCerts?: string }): Promise<AWSElastiCacheBackend>;
}
export class AzureRedisCacheBackend {
  static fromAccessKey(opts: { host: string; accessKey: string; port?: number; db?: number;
    ssl?: boolean }): Promise<AzureRedisCacheBackend>;                                       // port 6380, ssl true
  static fromManagedIdentity(opts: { host: string; username: string; port?: number; db?: number;
    ssl?: boolean; clientId?: string }): Promise<AzureRedisCacheBackend>;
  static fromServicePrincipal(opts: { host: string; username: string; tenantId: string;
    clientId: string; clientSecret: string; port?: number; db?: number; ssl?: boolean }): Promise<AzureRedisCacheBackend>;
}

export type CacheProvider = "redis" | "elasticache" | "azure_redis";
export type CacheAuthMethod =
  | "from_url" | "from_credentials" | "from_tls_cert"
  | "from_auth_token" | "from_iam_auth"
  | "from_access_key" | "from_managed_identity" | "from_service_principal";
export function getCache(provider: CacheProvider, authMethod: CacheAuthMethod,
                         options: Record<string, unknown>): Promise<CacheBackend>;
```

### 4.6 secrets

```ts
export abstract class SecretBackend {
  abstract getSecret(name: string): Promise<string>;
  getSecretJson(name: string): Promise<Record<string, unknown>>; // default: getSecret + JSON.parse (parse error → SecretError)
  abstract setSecret(name: string, value: string): Promise<void>;
  abstract deleteSecret(name: string): Promise<void>;
  abstract listSecrets(prefix?: string): Promise<string[]>;
  healthCheck(): Promise<boolean>;  // default: listSecrets("__cloudrift_health__"), catch → false
  close(): Promise<void>;           // default no-op
  [Symbol.asyncDispose](): Promise<void>;
}

export class AWSSecretsManagerBackend extends SecretBackend {
  static fromAccessKey(opts: AwsAccessKeyOptions): AWSSecretsManagerBackend;  // pool default 25, read 30s
  static fromIamRole(opts?: AwsIamRoleOptions): AWSSecretsManagerBackend;
  static fromProfile(opts: AwsProfileOptions): AWSSecretsManagerBackend;
}
export class AzureKeyVaultBackend extends SecretBackend {
  static fromManagedIdentity(opts: { vaultUrl: string; clientId?: string }): AzureKeyVaultBackend;
  static fromServicePrincipal(opts: { vaultUrl: string; tenantId: string; clientId: string;
                                      clientSecret: string }): AzureKeyVaultBackend;
}

export type SecretsProvider = "aws_secrets_manager" | "azure_keyvault";
export function getSecrets(provider: SecretsProvider,
                           options: Record<string, unknown>): Promise<SecretBackend>;
```

### 4.7 pubsub

```ts
export interface PubSubMessage {
  message: string;
  attributes?: Record<string, string>;
}

export abstract class PubSubBackend {
  abstract publish(topic: string, message: string,
                   attributes?: Record<string, string>): Promise<string>;
  abstract publishBatch(topic: string, messages: PubSubMessage[]): Promise<string[]>;
  healthCheck(): Promise<boolean>;  // default true
  close(): Promise<void>;           // default no-op
  [Symbol.asyncDispose](): Promise<void>;
}

export class AWSSNSBackend extends PubSubBackend {
  static fromAccessKey(opts: AwsAccessKeyOptions): AWSSNSBackend;
  static fromIamRole(opts?: AwsIamRoleOptions): AWSSNSBackend;
  static fromProfile(opts: AwsProfileOptions): AWSSNSBackend;
  // publishBatch chunks at 10; healthCheck → ListTopicsCommand
}
export class AzureEventGridBackend extends PubSubBackend {
  static fromAccessKey(opts: { endpoint: string; accessKey: string }): AzureEventGridBackend;
  static fromManagedIdentity(opts: { endpoint: string; clientId?: string }): AzureEventGridBackend;
  static fromServicePrincipal(opts: { endpoint: string; tenantId: string; clientId: string;
                                      clientSecret: string }): AzureEventGridBackend;
}

export type PubSubProvider = "sns" | "azure_eventgrid";
export function getPubsub(provider: PubSubProvider,
                          options: Record<string, unknown>): Promise<PubSubBackend>;
```

### 4.8 Root exports (`src/index.ts`)

Re-export everything: all factory functions (`getStorage`, `getStorageClient`,
`getQueue`, `getMongodb`, `getCache`, `getSecrets`, `getPubsub`), all backend/client
classes, all error classes, all public types (`Message`, `ObjectMetadata`,
`PubSubMessage`, provider string unions).

## 5. Error-mapping reference table

| Provider error | cloudrift error |
|---|---|
| S3 404 / `NoSuchKey` / `NotFound` | `ObjectNotFoundError` |
| S3 403 / `AccessDenied` | `StoragePermissionError` |
| Azure Blob `RestError` 404 / `BlobNotFound` | `ObjectNotFoundError` |
| Azure Blob `RestError` 403 | `StoragePermissionError` |
| SQS `AWS.SimpleQueueService.NonExistentQueue` / `QueueDoesNotExist` | `QueueNotFoundError` |
| SQS send failure / batch `Failed` entries | `MessageSendError` |
| Service Bus `MessagingEntityNotFound` | `QueueNotFoundError` |
| Secrets Manager `ResourceNotFoundException` (get/delete) | `SecretNotFoundError` |
| Secrets Manager `AccessDeniedException` | `SecretPermissionError` |
| Key Vault 404 | `SecretNotFoundError`; 403 → `SecretPermissionError` |
| SNS `NotFound` / `NotFoundException` | `TopicNotFoundError` |
| SNS batch `Failed` entries | `PublishError` |
| Event Grid 404 | `TopicNotFoundError`; 403 → `PubSubError`; else `PublishError` |
| ioredis connect failure | `CacheConnectionError`; op failure → `CacheError` |
| Mongo URI/construction failure | `DocumentConnectionError` |
| anything unmapped in domain X | domain base error (`StorageError`, …) |

Always pass the original error as `cause`.
