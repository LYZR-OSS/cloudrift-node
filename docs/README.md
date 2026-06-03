# cloudrift-ts Knowledge Base

`@lyzr/cloudrift` is the completed TypeScript port of `cloudrift-py`. This docs
directory is the system of record for agents working on the package. Keep this file as
the map; put detailed rules in the linked documents.

## Read Order

1. `../../AGENTS.md` for workspace rules.
2. `ARCHITECTURE.md` for the normative TypeScript API and provider seams.
3. `PARITY.md` before changing behavior that was copied from Python.
4. `TESTING.md` before adding or rewriting tests.
5. `AGENT_GUARDRAILS.md` before broad agent-driven changes.

## Document Map

| File                              | Purpose                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ARCHITECTURE.md`                 | Normative package layout, call graphs, type APIs, provider dispatch, and error mapping.             |
| `PARITY.md`                       | Python source-of-truth policy plus intentional TypeScript divergences.                              |
| `TESTING.md`                      | High-signal behavioral testing doctrine, deterministic harness rules, and current audit.            |
| `AGENT_GUARDRAILS.md`             | How autonomous agents should change this package without increasing entropy.                        |
| `RELIABILITY.md`                  | Runtime reliability expectations for lazy SDK loading, lifecycle, retries, and failure translation. |
| `SECURITY.md`                     | Credential, secret, logging, and provider-auth constraints.                                         |
| `PRODUCT_SENSE.md`                | Product boundary: what cloudrift is and is not for Lyzr services.                                   |
| `MAINTENANCE.md`                  | Required companion updates for providers, methods, exports, optional peers, and releases.           |
| `QUALITY_SCORE.md`                | Maintained quality assessment and known improvement targets.                                        |
| `PLANS.md`                        | How to create, execute, and retire implementation plans.                                            |
| `exec-plans/tech-debt-tracker.md` | Small durable backlog for follow-up debt.                                                           |
| `PORTING_PLAN.md`                 | Historical completion record, not a forward execution plan.                                         |

## Package Invariants

- Python is the behavior of record. TypeScript follows it unless `PARITY.md` records an
  intentional divergence.
- Provider SDKs are optional peers and must remain lazily imported.
- Provider-specific errors are translated at the adapter boundary into the CloudRift
  error tree, except document operations which surface native MongoDB driver errors.
- Tests must be deterministic and local-only by default.
- New docs should be short, linked from this index, and written so a future agent can
  decide where to look next without reading every file.
