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

Known improvement targets:

- Add a deterministic local-emulator layer for AWS storage, messaging, secrets, and
  pubsub parity. These tests should prove black-box behavior through public factories,
  not only SDK command payloads.
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
