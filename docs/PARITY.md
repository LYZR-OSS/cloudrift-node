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
- Redis `close()` uses ioredis `quit()` as the graceful close operation.
- Unknown cache provider or auth method throws `CloudRiftError`, not `ValueError`.
- Cache `hgetall` returns `Record<string, Buffer>` because JavaScript object keys are
  strings.
- Empty cache `delete()` and `hdel()` calls return `0` instead of forwarding empty
  varargs to Redis.
- Azure Key Vault null secret values are coerced to `""` to satisfy the
  `Promise<string>` contract.

When adding a divergence, include the reason, affected file/API, and the test asserting
the behavior.
