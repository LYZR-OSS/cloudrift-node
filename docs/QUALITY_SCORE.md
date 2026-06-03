# Quality Score

Current package grade: **B+**

The TypeScript port is complete and covered by a broad deterministic suite. The latest
review findings around provider boundaries, batch limits, optional declarations, and
lint usability have been remediated with regression coverage or mechanical verification.
The remaining score gap is about deeper system confidence: emulator-backed behavior,
export inventory checks, and broader Azure fake coverage.

This scorecard follows the Fallow-style habit of scoring from deterministic evidence:
changed-code risk, dependency hygiene, API surface health, architecture/parity drift,
and cleanup targets should be traceable to docs, tests, or mechanical checks rather than
review memory.

## Scorecard

| Dimension                  | Score | Evidence                                                                            | Target                                                                 |
| -------------------------- | ----- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| API and declaration health | B+    | `dist/**/*.d.ts` is free of optional provider SDK imports after build verification. | Add a CI declaration-surface inventory check.                          |
| Python parity              | B     | `azure_bus` dispatch, AWS profile auth, and provider batch limits are covered.      | Add a generated provider-literal inventory against Python.             |
| Provider reliability       | B     | AWS/SNS/SQS and Service Bus regressions have focused deterministic tests.           | Add emulator-backed black-box AWS behavior tests.                      |
| Dependency hygiene         | B     | ElastiCache IAM signer packages are declared as optional peers and dev deps.        | Add a dynamic-import/package metadata inventory test.                  |
| Test determinism           | A-    | Default suite is local and deterministic.                                           | Keep no-live-cloud/no-sleep guarantees while adding targeted coverage. |
| Agent guardrails           | B     | Docs are useful, but lint/script and export checks are not fully mechanical yet.    | `build:check` is usable and doc/API inventories are enforced.          |

## Review Remediation Ledger

These findings are not intentional divergences. Reopen any row if the cited evidence is
removed or stops running in `build:check`.

| Finding                                         | Status           | Expected fix                                                                                       | Evidence required for closure                                                 |
| ----------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| AWS SNS and Secrets Manager `fromProfile`       | Verified current | Load `@aws-sdk/credential-providers` lazily and call `fromIni({ profile: profileName })`.          | `tests/pubsub.test.ts` and `tests/secrets.test.ts` assert `fromIni`.          |
| Azure Service Bus `sendBatch` capacity handling | Verified current | Honor `tryAddMessage()` returning `false`; flush the current batch or reject an oversized message. | `tests/messaging.test.ts` covers split batches and oversized single messages. |
| AWS SQS `sendBatch` limit                       | Verified current | Chunk into SQS batches of at most 10 entries.                                                      | `tests/messaging.test.ts` covers 25 messages as `10, 10, 5`.                  |
| Optional SDK declaration leaks                  | Verified manual  | Keep exported declaration files free of provider SDK nominal types.                                | `npm run build` plus `rg` found no provider SDK imports in `dist/**/*.d.ts`.  |
| Azure Service Bus provider alias drift          | Verified current | Accept Python-compatible `azure_bus`; keep `azure_service_bus` as compatibility alias.             | `tests/messaging.test.ts` covers normalized `AZURE_BUS`.                      |
| ElastiCache IAM dynamic imports                 | Verified current | Declare every dynamically imported AWS SigV4 package as optional peer and dev deps.                | `package.json` and `package-lock.json` include signer and SHA-256 packages.   |
| Lint script usability                           | Verified current | Keep `npm run lint` executable in the supported Node/npm toolchain.                                | `npm run lint` is part of `build:check` and succeeds on a clean checkout.     |

## Strong Areas

- Clear provider seams and subpath exports.
- Optional peer dependency model with lazy imports.
- Broad local tests across storage, messaging, cache, document, secrets, and pubsub.
- Python-sensitive behavior documented in architecture and parity notes.
- No live cloud dependencies in the default test suite.

## Gaps To Close

- AWS coverage is still mostly SDK command-shape testing; it needs deterministic
  emulator-backed behavioral tests comparable to Python's moto layer.
- Azure Key Vault and Azure Event Grid lack direct behavioral fake coverage.
- Root/subpath export inventory is not mechanically checked.
- Some provider dispatch coverage is uneven across domains.
- Time-dependent token and URL tests should use injected or frozen clocks.
- Documentation freshness is manual; no doc index/check script enforces links yet.
- `PORTING_PLAN.md` is historical and should not be used as the active execution map.

## Bar For A+

- Every public API, provider string, and factory path has contract coverage.
- Public declaration files do not require consumers to install optional provider SDKs
  unless they instantiate those providers at runtime.
- Dynamic imports, peer dependencies, dev dependencies, and missing-peer error messages
  are checked as one inventory.
- Provider batch APIs either implement provider chunking limits or reject unsupported
  batch sizes with domain errors.
- AWS behavior has local-emulator read/write/list/delete/send/purge tests, not only SDK
  command assertions.
- Every implemented Azure provider has deterministic fake tests for the public contract.
- Every intentional Python divergence is named in `PARITY.md` and tested.
- Docs index links are mechanically checked.
- Test suite has no wall-clock, random, or live-network assumptions.
- Repeated review comments have become tests, lint rules, or docs.
