# Testing Doctrine

The default test suite should be high-signal, behavioral, deterministic system testing.
It should tell an agent whether the package preserves the cloudrift contract without
requiring live AWS, Azure, Redis, or MongoDB resources.

## Test Pyramid For This Package

1. Contract tests for abstract backend behavior and public factories.
2. Provider-adapter tests using deterministic fakes or SDK command mocks.
3. Deterministic local-emulator system tests for AWS parity where command mocks cannot
   prove behavior.
4. Parity tests for Python-sensitive defaults, dispatch precedence, error mapping, and
   lifecycle.
5. Small algorithm tests for local logic such as token generation or URI construction.

Do not put live-cloud tests in the default `npm test` path. If live validation is ever
needed, it must be opt-in, separately named, and guarded by explicit environment checks.

SDK command mocks are useful, but they are not system tests. They prove the command
shape sent to an SDK; they do not prove read-after-write, delete visibility, queue
delivery, purge behavior, list pagination, metadata persistence, or not-found behavior
through an AWS-compatible API. The Python suite uses moto-backed local endpoints for
that confidence. The TypeScript package should add an equivalent deterministic local
emulator layer, likely LocalStack or a JS-friendly AWS emulator, while keeping command
shape tests for auth/config mapping.

## Determinism Rules

- No sleeps, polling loops, or wall-clock deadlines in default tests.
- Freeze or inject time when output includes dates, expirations, or signatures.
- Inject UUID/random providers when IDs are part of the assertion.
- Prefer exact behavioral assertions over snapshots.
- Use in-memory fakes when they model behavior; use SDK command mocks when the command
  shape is the contract.
- Reset mocks and in-memory stores in `beforeEach` or `afterEach`.
- Assert the public result and the boundary command/error when both are contractually
  relevant.
- Fakes must model provider error status/code fields, async iterator behavior, close
  calls, and auth constructor arguments when those are part of the contract.

## What Good Looks Like

Good tests should fail for the right reason:

- A changed factory precedence should break a dispatch test.
- A missing error translation should break an error-class and `cause` test.
- A provider command payload drift should break a command-shape test.
- A Python parity divergence should break a named parity test unless `PARITY.md` was
  updated intentionally.

Weak tests only assert that a mock was called, a command was sent, or an instance was
constructed. Those are acceptable only as supporting assertions next to a behavioral
outcome or in a narrow transport-shape test.

## Current Audit

The suite is broad, deterministic, and useful, but it is not yet a full behavioral
system-test harness:

- `tests/storage.test.ts` covers S3 command shapes plus Azure Blob fake behavior,
  pagination, ownership, stream uploads, presigned URLs, and error mapping.
- `tests/messaging.test.ts` covers SQS command shapes and a deterministic Service Bus
  fake.
- `tests/cache.test.ts` exercises Redis-like behavior through `ioredis-mock` and checks
  ElastiCache IAM token shape.
- `tests/document.test.ts` checks URI construction and MongoClient option behavior
  without opening network connections.
- `tests/secrets.test.ts` and `tests/pubsub.test.ts` cover AWS command shapes, batch
  behavior, profile dispatch, and error classes.

Fixed regression targets from the latest review:

- SNS and Secrets Manager profile factories load `fromIni({ profile })`.
- SQS `sendBatch` covers 25 messages and chunks at the AWS 10-entry limit.
- Service Bus `sendBatch` covers `tryAddMessage()` returning `false`, including an
  oversized single message.
- `getQueue("azure_bus", ...)` remains the Python-compatible dispatch path.
- ElastiCache IAM dynamic imports are represented in dependency metadata.
- Declaration output was manually checked to avoid optional SDK nominal imports; convert
  this to a CI inventory check.

Known improvement targets:

- Add a deterministic local-emulator layer for AWS storage, messaging, secrets, and
  pubsub parity. These tests should prove black-box behavior through public factories,
  not only SDK command payloads. (ADDRESSED for storage, secrets, messaging (SQS), and
  pubsub (SNS) via the AWS emulator lane below.)
- Add Azure Key Vault behavioral fake tests for auth dispatch, CRUD, list prefix,
  delete polling, error mapping, and close behavior.
- Add Azure Event Grid behavioral fake tests for auth dispatch, CloudEvent envelope,
  attributes/extensions, batch publishing, error mapping, and close behavior.
- Add a small cross-domain parity inventory test that proves every public root and
  subpath export expected by `ARCHITECTURE.md` is present.
- Freeze or inject time for token and SAS URL tests that depend on generated expiry
  values, and for Service Bus scheduled-message delay assertions.
- Add Azure factory dispatch tests for storage, secrets, and pubsub to match the
  existing messaging dispatch coverage.
- Add negative lazy-dependency tests that verify missing optional peer messages name the
  package to install.
- Add table-driven error mapping tests for each provider so unmapped SDK errors preserve
  `cause` consistently.

## Verification Commands

```sh
npm test
npm run typecheck
npm run lint
npm run build:check
```

Use `npm test -- --run tests/<file>.test.ts` for a focused loop.

## AWS emulator lane

The AWS emulator lane is the deterministic local-emulator layer called for by the audit:
it proves black-box AWS behavior (read-after-write, delete visibility, list/prefix,
metadata persistence, presigned fetchability, secret create/update/list/delete, SQS
JSON round-trip / delayed delivery / batch chunking / receipt-handle delete / purge, and
SNS publish/batch delivery to a subscribed queue) through the PUBLIC factories from
`src/index.ts` — not SDK command payloads. It is the TypeScript equivalent of the Python
suite's moto-backed endpoints.

It runs against a [LocalStack](https://localstack.cloud/) container started and torn down
by [Testcontainers](https://testcontainers.com/), so it **requires a running Docker
daemon**. Nothing about it is opt-in beyond Docker availability; there are no credentials
or env vars (LocalStack accepts dummy access keys). Tests live under
`tests/aws-emulator/**` and use `vitest.emulator.config.ts`; the default `npm test`
excludes that directory.

### Run command

```sh
npm run test:aws:emulator
```

The shared `tests/aws-emulator/globalSetup.ts` starts one
`localstack/localstack:3` container for the whole run, publishes its endpoint with
vitest's `provide("localstackEndpoint", url)`, and stops it on teardown. Hook timeouts are
generous (120s) because the first run pulls the image; per-test timeout is 30s.

### Harness

`tests/aws-emulator/harness.ts` is the shared contract for every emulator suite
(storage, secrets, SQS, and SNS all use it). Key exports:

- `awsOptions()` — the literal access-key option object the AWS factories accept:
  `{ awsAccessKeyId, awsSecretAccessKey, region, endpointUrl }` (flat `endpointUrl`, not a
  nested `clientOptions`). Storage callers spread in their own `bucket`.
- `endpoint()` — resolves the injected endpoint, normalized to a `127.0.0.1` host. The IP
  host forces the S3 SDK into path-style addressing (the cloudrift S3 backend deliberately
  does not force path-style) and avoids LocalStack's hostname-based service routing, so one
  endpoint serves S3, Secrets Manager, SQS, and SNS.
- `uniqueName(kind)` — lowercase, S3-safe unique resource names.
- Raw-SDK provisioning helpers used only for setup/teardown: `createBucket`,
  `emptyAndDeleteBucket`, `createQueue`/`deleteQueue`, `createTopic`/`deleteTopic`,
  `subscribeQueueToTopic` (raw-message-delivery).

No sleeps or polling loops: LocalStack's semantics are synchronous, so each test relies on
read-after-write directly. State is isolated with unique names per resource.

## Live test lane

The live lane is an opt-in, separately-named suite that validates the public
factories against REAL cloud providers. It behaves like a tiny consumer app:
read env, instantiate the public factories from `src/index.ts`, run one minimal
lifecycle per provider, assert the side effects, then clean up aggressively.

These tests live under `tests/live/**` and use `vitest.live.config.ts`. They are
NEVER part of the default `npm test` (which excludes `tests/live/**`). Every
`describe` is gated on its own env subset and SKIPS — it never fails — when the
required variables are absent.

### Guard variable

The master switch is `CLOUDRIFT_LIVE_TESTS=1`. Nothing in the lane runs unless it
is set to exactly `1`. With it unset, the entire suite reports as skipped (0
failures), which is the expected green state in CI without credentials.

### Run command

```sh
CLOUDRIFT_LIVE_TESTS=1 npm run test:live
```

Each provider group additionally requires its own variables (below); a group
whose subset is incomplete skips with the gate visible in its `describe` name.

### Live test logging

Live tests log lifecycle events because they touch real cloud resources. The log
lines use a `[live:<provider>]` prefix and report resource decisions, backend
initialization, lifecycle milestones, and cleanup actions. Credential-bearing
fields such as connection strings, tokens, secrets, passwords, access keys, and
URIs are redacted before logging.

### Environment variables

| Variable                                            | Group             | Purpose                                        |
| --------------------------------------------------- | ----------------- | ---------------------------------------------- |
| `CLOUDRIFT_LIVE_TESTS`                              | all               | Master switch; must be `1`                     |
| `CLOUDRIFT_LIVE_AWS_REGION`                         | AWS               | Region for all AWS groups                      |
| `CLOUDRIFT_LIVE_AWS_ACCESS_KEY_ID`                  | AWS               | Access-key auth (with secret)                  |
| `CLOUDRIFT_LIVE_AWS_SECRET_ACCESS_KEY`              | AWS               | Access-key auth (with id)                      |
| `CLOUDRIFT_LIVE_AWS_SESSION_TOKEN`                  | AWS               | Optional STS session token                     |
| `CLOUDRIFT_LIVE_AWS_PROFILE`                        | AWS               | Named-profile auth (alternative to access key) |
| `CLOUDRIFT_LIVE_AWS_BUCKET`                         | AWS S3            | Optional pre-provisioned bucket                |
| `CLOUDRIFT_LIVE_AWS_QUEUE_URL`                      | AWS SQS           | Optional pre-provisioned queue URL             |
| `CLOUDRIFT_LIVE_AWS_TOPIC_ARN`                      | AWS SNS           | Optional pre-provisioned topic ARN             |
| `CLOUDRIFT_LIVE_AZURE_STORAGE_CONNECTION_STRING`    | Azure Blob        | Storage connection string                      |
| `CLOUDRIFT_LIVE_AZURE_BLOB_CONTAINER`               | Azure Blob        | Optional pre-provisioned container             |
| `CLOUDRIFT_LIVE_AZURE_KEYVAULT_URL`                 | Azure Key Vault   | Vault URL                                      |
| `CLOUDRIFT_LIVE_AZURE_TENANT_ID`                    | Azure Key Vault   | Service principal tenant                       |
| `CLOUDRIFT_LIVE_AZURE_CLIENT_ID`                    | Azure Key Vault   | Service principal client id                    |
| `CLOUDRIFT_LIVE_AZURE_CLIENT_SECRET`                | Azure Key Vault   | Service principal secret                       |
| `CLOUDRIFT_LIVE_AZURE_EVENTGRID_ENDPOINT`           | Azure Event Grid  | Topic endpoint                                 |
| `CLOUDRIFT_LIVE_AZURE_EVENTGRID_KEY`                | Azure Event Grid  | Access key                                     |
| `CLOUDRIFT_LIVE_AZURE_SERVICEBUS_CONNECTION_STRING` | Azure Service Bus | Connection string                              |
| `CLOUDRIFT_LIVE_AZURE_SERVICEBUS_QUEUE`             | Azure Service Bus | Queue name                                     |
| `CLOUDRIFT_LIVE_MONGO_URI`                          | Document          | MongoDB-wire connection URI                    |
| `CLOUDRIFT_LIVE_MONGO_PROVIDER`                     | Document          | `documentdb` (default) or `cosmos`             |
| `CLOUDRIFT_LIVE_REDIS_URL`                          | Cache             | `redis://` or `rediss://` URL                  |

AWS groups need `CLOUDRIFT_LIVE_AWS_REGION` plus either the access-key pair or
`CLOUDRIFT_LIVE_AWS_PROFILE`.

### Safety notes

- Create-if-permitted: when no pre-provisioned override is set, the lane creates
  a uniquely-named bucket/queue/topic/container via the raw SDK and deletes it in
  `afterAll`. Buckets are emptied before deletion.
- Prefix-scoped cleanup: on env-provided resources the lane only ever touches its
  own uniquely-prefixed keys/secrets/collections. It NEVER deletes an
  env-provided bucket/queue/topic/container and NEVER purges an env-provided
  queue.
- All resource names are collision-free (`uniqueName`, lowercase + S3-safe).
- Cleanup runs in `afterAll` wrapped in try/catch (`console.warn` on failure) so
  a cleanup error never masks a test failure.
- No unbounded polling: SQS and Service Bus receives use the API's own bounded
  long-poll / max-wait, not manual sleep loops.
