# Python Parity

`cloudrift-py` (remote: https://github.com/NeuralgoLyzr/lyzr-cloudrift) is the behavioral source of truth for `@lyzr/cloudrift`. The TypeScript
package exists so Node.js services can use the same cloud-provider abstractions with
idiomatic TypeScript shapes.

## Source Order

When behavior is unclear, resolve it in this order:

1. `../../cloudrift-py/cloudrift/<domain>/`
2. `../../cloudrift-py/tests/test_<domain>.py`
3. `../../cloudrift-py/docs/`
4. `ARCHITECTURE.md`
5. TypeScript implementation and tests

## Translation Rules

| Python                                 | TypeScript                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| snake_case public functions and params | camelCase public API, provider/config literals kept as Python-compatible strings |
| `bytes`                                | `Buffer` return values; `Buffer`, `Uint8Array`, or `string` inputs where useful  |
| async context manager                  | `close()` plus `Symbol.asyncDispose`                                             |
| Python exception tree                  | CloudRift `Error` subclasses with `cause`                                        |
| extras                                 | optional peer dependencies with lazy SDK loading                                 |

Provider strings, auth method strings, factory precedence, error categories, lifecycle,
and default methods are parity-sensitive.

## Parity-Sensitive Fixes

These review findings are fixed behavior, not intentional divergences. Keep them covered
when refactoring provider factories.

- Python messaging uses provider literal `azure_bus`; TypeScript accepts it and keeps
  `azure_service_bus` as a compatibility alias.
- AWS `from_profile` semantics require the AWS shared-profile credential provider
  (`fromIni` in the AWS SDK for JavaScript) for SQS, SNS, Secrets Manager, and S3.
- Provider batch limits are part of behavior: SNS and SQS batch APIs chunk to the
  10-entry AWS limit, and Azure Service Bus batches honor `tryAddMessage()` capacity
  failures.

## Intentional Divergences

These divergences are retained because they are safer or more idiomatic in TypeScript:

- Unmapped messaging parse or SDK failures are wrapped in `MessagingError` instead of
  leaking raw non-SDK errors.
- Azure Service Bus session receive uses the JS SDK's `acceptSession(queue, sessionId)` /
  `acceptNextSession(queue)` (which return a `ServiceBusSessionReceiver`) rather than
  Python's `get_queue_receiver(session_id=NEXT_AVAILABLE_SESSION)` — the JS SDK has no
  `NEXT_AVAILABLE_SESSION` sentinel. The "no session currently available" case is
  detected by the SDK error `code` (`ServiceTimeout` / `SessionCannotBeLocked`), the JS
  analogue of Python's `OperationTimeoutError`, and is normalized to an empty receive
  (and to loop termination in `purge()`), matching Python's behavior. Unlike Python's
  `max_wait_time` on the session receiver, `acceptNextSession` takes no poll timeout in
  this SDK version; callers relying on bounded session polling should set an abort signal
  upstream.
- Standard (non-FIFO) SQS sends omit `DelaySeconds` when the delay is `0` (Python
  e643def returns `{}` for a falsy delay) instead of always sending `DelaySeconds: 0`.
- Redis `close()` uses ioredis `quit()` as the graceful close operation.
- Unknown cache provider or auth method throws `CloudRiftError`, not `ValueError`.
- Cache `hgetall` returns `Record<string, Buffer>` because JavaScript object keys are
  strings.
- Empty cache `delete()` and `hdel()` calls return `0` instead of forwarding empty
  varargs to Redis.
- Azure Key Vault null secret values are coerced to `""` to satisfy the
  `Promise<string>` contract.
- Email MIME assembly uses `nodemailer`'s buffered stream transport
  (`createTransport({ streamTransport: true, buffer: true })`) instead of a
  stdlib MIME builder (Node has none). This keeps the dependency surface to the
  bare `nodemailer` package — equivalent output to Python's
  `email.message.EmailMessage` / Go's `mime/multipart`. SES still chooses the
  Simple vs Raw (MIME) content path exactly as Python does (Raw only when
  attachments or custom headers are present).
- The SMTP backend uses `nodemailer` transports (one per `send`, matching
  Python's fresh-connection-per-send) and maps errors by SMTP `responseCode`
  plus nodemailer's `EENVELOPE` error name (rejected recipients →
  `RecipientRejectedError`, otherwise `SenderUnverifiedError`) rather than
  `aiosmtplib`'s typed exception classes.
- The Azure ACS email backend uses the official `@azure/communication-email`
  `EmailClient.beginSend(...).pollUntilDone()` (the Node SDK is async-native),
  rather than Python's `asyncio.to_thread`-wrapped sync client. Error mapping
  keys off the SDK error `statusCode` and message substring exactly as Python.
- SQL: MS SQL Server certificate pinning (`serverCertificate` / the Python
  `cloudrift/sql/_mssql_tls.py` TDS-PRELOGIN + MemoryBIO fingerprint check) is not
  reimplemented in `src/sql/mssqlTls.ts`. Node has no MemoryBIO TLS primitive and the
  npm `mssql`/`tedious` driver exposes its own `encrypt`/`trustServerCertificate` trust
  options, so `validatePinnedCertificate()` (and any `connect()` passing
  `serverCertificate`) throws a clear `SQLConnectionError`. Asserted in
  `tests/sql.test.ts` ("serverCertificate pinning throws", "validatePinnedCertificate").
- SQL: MS SQL Entra/AAD tokens are passed through the `mssql` driver's
  `authentication: { type: "azure-active-directory-access-token", options: { token } }`
  config rather than Python's ODBC `SQL_COPT_SS_ACCESS_TOKEN` (1256) pre-connect
  attribute / UTF-16-LE token struct. A fresh token is still minted per `connect()`, so
  the per-connection token-freshness behavior is preserved (`src/sql/mssql.ts`).
- SQL: Python wraps the synchronous `oracledb` / `databricks-sql-connector` drivers with
  `asyncio.to_thread`; the Node `oracledb` and `@databricks/sql` clients are natively
  async, so the thread offload is dropped while `connect()`'s timeout-and-error behavior
  is preserved (`src/sql/oracle.ts`, `src/sql/databricks.ts`).
- SQL: AWS RDS IAM auth tokens are generated via `@aws-sdk/rds-signer`'s `Signer`
  (the JS equivalent of boto3 `generate_db_auth_token`) instead of boto3; failures map to
  `SQLAuthError` (`src/sql/postgresql.ts`, `src/sql/mysql.ts`).
- Cache `pipeline()` stays a true Redis MULTI/EXEC transaction (atomic, one
  round trip). Python v0.2.5 added a generic non-atomic `_SequentialPipeline`
  base that replays queued ops one-by-one; the Node SDK keeps its server-side
  MULTI pipeline (`src/cache/redisBase.ts`, `RedisPipeline`) and extends it to
  cover the new queued ops (`expire`, `sadd`, `srem`). This is stronger than
  Python's default (atomic vs. best-effort). Covered by the pipeline tests in
  `tests/cache.test.ts`.
- Cache set reads `smembers()` and `sinter()` return an ordered array
  (`Buffer[]`, or `string[]` when `decodeResponses` is set) rather than Python's
  `set[bytes]`. JavaScript `Set` compares `Buffer`s by reference, so a real set
  would not deduplicate by value; an array also matches the existing
  `lrange`/`mget` shape. Redis already guarantees member uniqueness. The
  zero-key `sinter()` guard throws `CloudRiftError` (Python `ValueError`)
  (`src/cache/redisBase.ts`, asserted in `tests/cache.test.ts`).
- Cache `decodeResponses` (mirrors redis-py `decode_responses`) is implemented
  by decoding the `*Buffer` read results to UTF-8 strings at the backend
  boundary (`src/cache/redisBase.ts`), since ioredis has no equivalent client
  option. Default `false` preserves the `Buffer` contract; all read return types
  widen to `CacheReadValue` (`Buffer | string`).
- Cache `expire()` `nx`/`xx` flags are passed as a single `ExpireOptions` object
  (`expire(key, seconds, { nx })`) instead of two positional booleans; passing
  both throws `CloudRiftError` (Python `ValueError`).
- Cache `cacheBrokerUrl()` defaults `sslCertReqs` to `CERT_NONE`
  (`src/cache/index.ts`). This matches the Python `cache_broker_url()` _signature_
  default (`CERT_NONE`), even though the Python docstring text says
  `CERT_REQUIRED`; behavior follows the actual default.
- Cache `getCache()` normalizes the `provider` and `authMethod` arguments
  (trim + lowercase, via `normalizeChoice`) before dispatch, whereas Python's
  `get_cache()` requires an exact, case-sensitive match (`provider == "redis"`
  and `getattr(_Backend, auth_method)`). So `getCache(" REDIS ", " FROM_URL ", …)`
  succeeds in Node but the Python equivalent would raise. This is intentional and
  consistent with the storage/messaging factories' input normalization
  (`src/cache/index.ts`, asserted in `tests/cache.test.ts` —
  "normalizes provider and auth method values from config").
- Document: Node's single `mongodb` driver is async-only, so Python's sync/async
  split (`get_mongodb` vs. a synchronous variant) collapses to one async
  `getMongodb` factory (`src/document/index.ts`). No `getMongodbSync` alias is
  added — there is no synchronous MongoDB client in the Node driver, so a sync
  alias would be misleading; all `MongoClientLike` operations are promise-based.

When adding a divergence, include the reason, affected file/API, and the test asserting
the behavior.
