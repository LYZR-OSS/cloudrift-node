# Port Completion Record

The `cloudrift-py` to `cloudrift-ts` port is complete. This file is retained as a
historical record of what was ported; it is not the active execution plan. Use
`README.md`, `ARCHITECTURE.md`, `PARITY.md`, and `TESTING.md` for current guidance.

## Delivered Package

| Concern      | Result                                                                             |
| ------------ | ---------------------------------------------------------------------------------- |
| Package      | `@lyzr/cloudrift`                                                                  |
| Runtime      | Node.js >= 20                                                                      |
| Language     | TypeScript, strict mode                                                            |
| Build        | ESM + CJS via `tsup`                                                               |
| Entry points | root plus `core`, `storage`, `messaging`, `cache`, `secrets`, `pubsub`, `document` |
| Tests        | Vitest deterministic local suite                                                   |
| Dependencies | Provider SDKs as optional peers, loaded lazily                                     |

## Delivered Domains

| Domain    | Providers                                       |
| --------- | ----------------------------------------------- |
| storage   | S3, Azure Blob                                  |
| messaging | SQS, Azure Service Bus                          |
| document  | DocumentDB Mongo API, Cosmos Mongo API          |
| cache     | Redis, ElastiCache Redis, Azure Cache for Redis |
| secrets   | AWS Secrets Manager, Azure Key Vault            |
| pubsub    | SNS, Azure Event Grid                           |

## Current Sources Of Truth

- `../../cloudrift-py/cloudrift/` and `../../cloudrift-py/tests/` define behavior.
- `ARCHITECTURE.md` defines TypeScript public APIs and provider seams.
- `PARITY.md` records intentional Python divergences.
- `TESTING.md` defines the deterministic test bar and current audit.

## Historical Notes

The port intentionally kept Python-compatible provider strings and auth method strings
so environment-driven service configuration remains portable. TypeScript uses idiomatic
camelCase methods, `Buffer` values for byte payloads, `close()` plus
`Symbol.asyncDispose`, and optional npm peer dependencies instead of Python extras.
