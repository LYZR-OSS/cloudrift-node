# Technical Debt Tracker

Small, durable follow-ups for future agents.

| Item                                 | Area                             | Why It Matters                                                                  | Status |
| ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------- | ------ |
| AWS emulator behavioral harness      | storage/messaging/secrets/pubsub | Command mocks do not prove AWS-compatible black-box behavior.                   | open   |
| Azure Key Vault fake coverage        | secrets                          | Implemented provider has no direct behavioral tests yet.                        | open   |
| Azure Event Grid fake coverage       | pubsub                           | Implemented provider has no direct behavioral tests yet.                        | open   |
| Export inventory contract test       | package                          | Prevents root/subpath API drift from silently breaking consumers.               | open   |
| Frozen clock for signed-output tests | tests                            | Makes token and SAS URL tests independent of wall-clock timing.                 | open   |
| Azure dispatch parity sweep          | storage/secrets/pubsub           | Messaging has stronger dispatch tests than other Azure domains.                 | open   |
| Missing optional peer tests          | core/provider factories          | Ensures install guidance stays clear when a consumer installs only one backend. | open   |
| Docs link checker                    | docs                             | Keeps the agent knowledge map from rotting.                                     | open   |
