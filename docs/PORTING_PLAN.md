# Porting Plan: cloudrift-py → cloudrift-ts

Port of `lyzr-cloudrift` (Python, v0.2.0) to a Node.js TypeScript package with identical
semantics and an idiomatic-TypeScript public API.

## 1. What cloudrift is

Cloudrift is a cloud-agnostic infrastructure abstraction library for Lyzr microservices.
It provides unified async APIs across AWS, Azure, and self-hosted backends:

| Domain    | AWS                 | Azure                 | Self-hosted |
| --------- | ------------------- | --------------------- | ----------- |
| storage   | S3                  | Blob Storage          | —           |
| messaging | SQS                 | Service Bus           | —           |
| document  | DocumentDB (Mongo)  | Cosmos DB (Mongo API) | —           |
| cache     | ElastiCache (Redis) | Azure Cache for Redis | Redis       |
| secrets   | Secrets Manager     | Key Vault             | —           |
| pubsub    | SNS                 | Event Grid            | —           |

Core constraints carried over from the Python design (see `cloudrift-py/docs/DESIGN.md`):

- **Async-first** — every public method returns a `Promise`; native async SDKs only.
- **Drop-in providers** — same interface across clouds where semantics are compatible;
  provider selection by a single string at the factory.
- **Explicit over hidden** — provider differences affecting correctness/cost are visible
  in docs or exceptions, never silently normalized.
- **Not** an ORM, worker framework, or application platform.
- **Unified error hierarchy** — all provider errors translated at the boundary to a
  single `CloudRiftError` tree (exception: document module surfaces native MongoDB
  driver errors for operations; only connect-time failures become `DocumentConnectionError`).
- **Lifecycle** — backends are constructed once at service startup, reused, and closed at
  shutdown (`close()` / `Symbol.asyncDispose` via `await using`).

## 2. Target stack

| Concern         | Choice                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Package name    | `@lyzr/cloudrift`                                                                                                          |
| Language        | TypeScript 5.x, `strict: true`                                                                                             |
| Runtime         | Node.js >= 20                                                                                                              |
| Module format   | ESM + CJS dual build via `tsup`                                                                                            |
| Entry points    | Subpath exports: `@lyzr/cloudrift`, `./storage`, `./messaging`, `./cache`, `./secrets`, `./pubsub`, `./document`, `./core` |
| Tests           | `vitest`                                                                                                                   |
| Lint/format     | `eslint` (typescript-eslint) + `prettier`                                                                                  |
| Package manager | `npm`                                                                                                                      |

### Dependency mapping (Python → npm)

| Python                       | npm                                                    |
| ---------------------------- | ------------------------------------------------------ |
| `aioboto3` (S3)              | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` |
| `aioboto3` (SQS)             | `@aws-sdk/client-sqs`                                  |
| `aioboto3` (SNS)             | `@aws-sdk/client-sns`                                  |
| `aioboto3` (Secrets Manager) | `@aws-sdk/client-secrets-manager`                      |
| profile auth                 | `@aws-sdk/credential-providers` (`fromIni`)            |
| `azure-storage-blob`         | `@azure/storage-blob`                                  |
| `azure-servicebus`           | `@azure/service-bus`                                   |
| `azure-keyvault-secrets`     | `@azure/keyvault-secrets`                              |
| `azure-eventgrid`            | `@azure/eventgrid`                                     |
| `azure-identity`             | `@azure/identity`                                      |
| `redis[hiredis]`             | `ioredis`                                              |
| `motor`                      | `mongodb` (native async driver)                        |
| `moto` (tests)               | `aws-sdk-client-mock`                                  |
| `fakeredis` (tests)          | `ioredis-mock`                                         |

**Optional install strategy.** Python uses extras (`pip install lyzr-cloudrift[aws]`).
npm has no extras, so all provider SDKs are declared as **optional `peerDependencies`**
(`peerDependenciesMeta: { optional: true }`) and imported **lazily inside factory
methods** (dynamic `import()` or guarded `require`). A user who installs only
`@aws-sdk/client-s3` can use S3 storage without pulling Azure SDKs. Missing-SDK errors
must be clear: `CloudRiftError: install @azure/storage-blob to use the azure_blob provider`.
Test devDependencies include all SDKs.

## 3. API translation conventions

| Python                              | TypeScript                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_storage(provider, **kwargs)`   | `getStorage(provider, options)` — discriminated options object                                                                                                                                                                                                                                      |
| `from_access_key(...)` classmethods | `static fromAccessKey(opts)`                                                                                                                                                                                                                                                                        |
| snake_case methods/params           | camelCase (`getSecretJson`, `presignedUrl`, `expiresIn`)                                                                                                                                                                                                                                            |
| `bytes`                             | `Buffer` (accept `Buffer \| Uint8Array \| string` on input, return `Buffer`)                                                                                                                                                                                                                        |
| `dict` message bodies               | `Record<string, unknown>` (JSON-serializable)                                                                                                                                                                                                                                                       |
| `AsyncIterator[bytes]`              | `AsyncIterable<Buffer \| Uint8Array>`                                                                                                                                                                                                                                                               |
| `async with backend:`               | `await using backend = ...` (`Symbol.asyncDispose`) plus explicit `close()`                                                                                                                                                                                                                         |
| ABC (`StorageBackend`)              | `abstract class` (kept as classes, not interfaces, to preserve default method impls: `move`, `healthCheck`, `listIter`, `setex`)                                                                                                                                                                    |
| Exceptions                          | `class ObjectNotFoundError extends StorageError extends CloudRiftError extends Error`, with `cause` set to the provider error                                                                                                                                                                       |
| `@dataclass Message`                | `interface Message`                                                                                                                                                                                                                                                                                 |
| Provider strings                    | identical literals: `"s3" \| "azure_blob"`, `"sqs" \| "azure_service_bus"`, `"redis" \| "elasticache" \| "azure_redis"`, `"aws_secrets_manager" \| "azure_keyvault"`, `"sns" \| "azure_eventgrid"`, `"documentdb" \| "cosmos"` — must match Python so env-driven config is portable across services |

Factory auth dispatch is preserved: the factory inspects which option keys are present
(e.g. `awsAccessKeyId` → `fromAccessKey`, `profileName` → `fromProfile`, else
`fromIamRole`; `connectionString` / `clientSecret` / etc. on Azure) — same precedence
order as Python. See `ARCHITECTURE.md` §3 for exact dispatch tables.

## 4. Module-by-module port plan

Each module ports `base` (abstract class + defaults), provider adapters, factory, and
contract tests. Full type signatures are in `ARCHITECTURE.md`.

### 4.1 core

- `errors.ts`: full exception tree (22 classes) mirroring `cloudrift/core/exceptions.py`.
- `lazy.ts`: helper for lazy SDK loading with clear missing-dependency errors.

### 4.2 storage (S3, Azure Blob)

- `StorageBackend` abstract class: `upload`, `download`, `delete`, `exists`, `list`,
  `listIter`, `presignedUrl`, `copy`, `move` (default = copy+delete), `getMetadata`,
  `uploadStream`, `healthCheck` (default = `exists("__cloudrift_health__")`), `close`.
- **Client/Backend split**: `AWSS3Client` / `AzureBlobClient` are account-scoped (one
  connection pool); `.bucket(name)` / `.container(name)` return backend views with
  `ownsClient=false` (their `close()` is a no-op). `getStorage()` returns an owning
  single-bucket view; `getStorageClient()` returns the account-scoped client.
- S3: presigned URLs via `@aws-sdk/s3-request-presigner`; lazy list via `ListObjectsV2`
  pagination; `uploadStream` buffers chunks then uploads (parity with Python).
- Azure: presigned URL requires `accountKey` (uses `generateBlobSASQueryParameters`);
  `uploadStream` passes the stream through (true streaming); cross-container `copy` via
  `beginCopyFromURL`.
- Error mapping: 404/NoSuchKey → `ObjectNotFoundError`; 403 → `StoragePermissionError`;
  else `StorageError`.

### 4.3 messaging (SQS, Service Bus)

- `Message` interface: `{ id, body, receiptHandle, attributes }`.
- `MessagingBackend`: `send(message, delay=0)`, `sendBatch`, `receive(maxMessages=1,
waitTime=0)`, `delete(receiptHandle)` (ack), `purge`, `healthCheck`, `close`.
- SQS: JSON-serialize bodies; `DelaySeconds`; batch via `SendMessageBatch` with `Failed`
  checking.
- Service Bus: single AMQP connection; receiver + lock-token tracking so `delete()` can
  complete messages received earlier; receiver closed when its last message is acked;
  `purge()` = receive-and-complete loop. **Known debt carried over**: ack semantics
  mismatch with SQS (documented, not redesigned in this port — parity first).

### 4.4 document (DocumentDB, Cosmos — Mongo API)

- `getMongodb(provider, options)` returns a **native `MongoClient`** from the `mongodb`
  package — no wrapper (matches the v0.2.0 Motor-direct design).
- DocumentDB helpers: `connectUri`, `connectCredentials` (URI-encodes user/pass),
  `connectTlsCert`; Cosmos helpers: `connectConnectionString`, `connectAccountKey`
  (builds URI with `ssl=true&replicaSet=globaldb&retryWrites=false&maxIdleTimeMS=120000`).
- Pool options `maxPoolSize`/`minPoolSize` (defaults 100/0). Construction failures →
  `DocumentConnectionError`; operation errors stay native driver errors.
- Note: the `mongodb` driver connects lazily; `connect()` is invoked by first operation.
  We construct the client and let errors surface per driver semantics, wrapping
  synchronous/URI-parse failures as `DocumentConnectionError`.

### 4.5 cache (Redis ×3)

- `CacheBackend` abstract class with full op set (KV, hash, list, counters, multi-key,
  admin, `pipeline()`).
- `RedisMixin` equivalent: a concrete `BaseRedisBackend extends CacheBackend` holding an
  `ioredis` client and implementing all ops, wrapping ioredis errors as `CacheError`.
  The three providers (`StandaloneRedisBackend`, `AWSElastiCacheBackend`,
  `AzureRedisCacheBackend`) differ only in static constructors.
- Value handling: return `Buffer` (use ioredis `*Buffer` command variants); `keys()`
  decodes to `string[]`; `hgetall` returns `Record<string, Buffer>`.
- ElastiCache IAM auth: SigV4 presigned-URL token generator (15-min tokens) wired into
  ioredis credential refresh (via `username`/`password` provider on reconnect).
- Azure Entra auth: token via `@azure/identity` credential; refresh on reconnect.
- Factory keeps the two-arg shape: `getCache(provider, authMethod, options)`.

### 4.6 secrets (Secrets Manager, Key Vault)

- `SecretBackend`: `getSecret`, `getSecretJson`, `setSecret` (put-then-create-on-404),
  `deleteSecret` (force, no recovery), `listSecrets(prefix)`,
  `healthCheck` (default = `listSecrets("__cloudrift_health__")`), `close`.
- AWS: lazy client + name-filter pagination. Azure: `beginDeleteSecret().pollUntilDone()`,
  prefix filter over `listPropertiesOfSecrets`.
- Error mapping: not-found → `SecretNotFoundError`; 403/AccessDenied →
  `SecretPermissionError`; JSON parse failure → `SecretError`.

### 4.7 pubsub (SNS, Event Grid)

- `PubSubBackend`: `publish(topic, message, attributes?)`, `publishBatch(topic,
messages)`, `healthCheck`, `close`.
- SNS: string attributes → `MessageAttributes` (DataType `String`); batch auto-chunked
  at 10 with `Failed` checking; health check via `listTopics`.
- Event Grid: wrap each message in a CloudEvent (`type: "cloudrift.event"`, `source:
topic`, random UUID id, attributes as extensions); `healthCheck` returns `true`.

## 5. Testing strategy

Mirror the Python test suite 1:1 in intent (≈93 tests across 6 files):

| Suite               | Mocking approach                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cache.test.ts`     | `ioredis-mock` (parity with fakeredis): KV/TTL/hash/list/counters/mget/mset, factory dispatch, invalid provider                                                   |
| `storage.test.ts`   | `aws-sdk-client-mock` on `S3Client`: upload/download/delete/exists/list/listIter/metadata/copy/move/presigned/uploadStream; client/backend split & view ownership |
| `messaging.test.ts` | `aws-sdk-client-mock` on `SQSClient`: send/sendBatch/receive/delete/purge/healthCheck, invalid provider                                                           |
| `secrets.test.ts`   | `aws-sdk-client-mock` on `SecretsManagerClient`: CRUD, JSON, prefix list, create-on-404 fallback, error mapping                                                   |
| `pubsub.test.ts`    | `aws-sdk-client-mock` on `SNSClient`: publish, attributes, batch >10 chunking, healthCheck                                                                        |
| `document.test.ts`  | Recording/DI of `MongoClient` constructor (no real connections): URI building, pool defaults/overrides, password URL-encoding, Cosmos URI construction            |

Azure adapters get unit tests with hand-rolled fakes of the SDK client surface (the
Python suite also only mock-tests AWS; we match and slightly exceed that). No live-cloud
tests in CI.

Definition of done per module: `tsc --noEmit` clean, vitest green, public API matches
`ARCHITECTURE.md` signatures exactly.

## 6. Execution phases

1. **Scaffold** — package.json (exports map, optional peer deps), tsconfig, tsup,
   vitest, eslint/prettier, `src/core/` (errors + lazy-import helper), CI-ready
   `npm run build/test/lint`. Commit.
2. **Modules in parallel** — six independent agents, one per domain, each implementing
   `src/<module>/` + `tests/<module>.test.ts` against `ARCHITECTURE.md` and the Python
   source as spec. No commits during this phase (avoids index races).
3. **Integration** — root `src/index.ts` re-exports, `npm install`, fix cross-module
   compile errors, full `vitest run`, lint. Commit.
4. **Parity review** — adversarial check of TS public surface vs the Python inventory
   (every class, method, default, error mapping); README + docs. Fix gaps. Commit.

## 7. Risks / open items

- **Service Bus ack mismatch** is pre-existing debt in Python (`tech-debt-tracker.md`);
  ported as-is, documented.
- **ioredis credential refresh** for ElastiCache IAM / Entra tokens differs mechanically
  from redis-py `CredentialProvider`; implemented via ioredis reconnect hooks — needs a
  focused unit test of the token-generation function itself.
- **Buffer vs string ergonomics** in cache: Python returns `bytes`; TS returns `Buffer`.
  Callers can `.toString()`. Documented in README.
- **`@azure/eventgrid` API drift**: the CloudEvent send shape must be validated against
  the current SDK major at implementation time.
- Python's `__init__.py` re-exports everything at top level; TS mirrors this in the root
  entry plus per-domain subpath exports.

### 7.1 Parity-review findings — deferred minors (intentional divergences)

The finalization pass fixed all critical/major findings and the cheap minors. The
following minor divergences are **deliberately retained**; they are either
spec-sanctioned (`ARCHITECTURE.md`) or the TS behavior is the safer/more idiomatic
choice. Recorded here for awareness:

- **Broader error-catch scope (messaging SQS `sqs.ts`, Azure `azureBus.ts`).** Python
  wraps only `ClientError` / `HttpResponseError` and lets non-SDK errors (e.g. a
  `JSON.parse`/`json.loads` failure on a malformed body in `receive()`) propagate raw.
  TS funnels every caught error through `mapError`/`mapReceiveError`, so a body-parse
  failure surfaces as `MessagingError` instead of a raw `SyntaxError`. This matches the
  `ARCHITECTURE.md` error-table rule "anything unmapped in domain X → domain base
  error", so it is kept intentionally. Low impact (only affects malformed-payload
  failure typing).
- **Cache `close()` uses ioredis `quit()` (`redisBase.ts`).** Python `_RedisMixin.close()`
  calls `aclose()` (pool teardown, no guaranteed server QUIT). `quit()` is the graceful
  analog and issues an actual QUIT; it can block/fail on a half-open socket where
  `aclose()` would not. Kept as the documented graceful-close choice.
- **Cache factory error type (`cache/index.ts`).** Python `get_cache` raises `ValueError`
  for unknown provider/auth-method; TS throws `CloudRiftError`. Sanctioned by
  `ARCHITECTURE.md` (single CloudRift error tree) and asserted by `cache.test.ts`.
- **Cache `hgetall` key type (`redisBase.ts`).** Python returns `dict[bytes, bytes]`; TS
  returns `Record<string, Buffer>` (string field names) per `ARCHITECTURE.md` §4.5.
  Non-UTF-8 field-name bytes would round-trip differently. Idiomatic for JS object keys.
- **Empty-varargs `delete()` / `hdel()` (`redisBase.ts`).** TS short-circuits to `0` on
  zero keys/fields; Python forwards the empty splat and redis-py raises. The TS guard is
  intentional and asserted by `cache.test.ts`.
- **Azure Key Vault `getSecret` null coercion (`azureKeyvault.ts`).** Python returns
  `secret.value` (may be `None`); TS returns `secret.value ?? ""`. Python does NOT error
  on a null value, so hard-failing in TS would diverge _more_; the `?? ""` coercion is
  the type-safe analog for the `Promise<string>` contract. (Note: AWS Secrets Manager
  `getSecret` was changed to hard-fail when `SecretString` is undefined, because there
  Python _does_ hard-fail via `KeyError`.)
