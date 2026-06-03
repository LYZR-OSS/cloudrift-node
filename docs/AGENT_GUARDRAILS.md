# Agent Guardrails

The TypeScript package is maintained by autonomous AI agents. Humans steer behavior and
review outcomes; agents implement, test, document, and repair. This works only if the
repository stays legible and mechanically checkable.

## Operating Model

- Treat repository-local Markdown, tests, types, and scripts as the only durable memory.
- Make `AGENTS.md` a table of contents, not an encyclopedia.
- Encode repeated review feedback in docs, tests, lint, or helpers.
- Prefer small, composable changes with an explicit verification command.
- Do not depend on chat context for behavior that future agents must preserve.

## Before Editing

1. Check the package status with `git -C cloudrift-ts status --short`.
2. Read `docs/README.md` and the domain section in `docs/ARCHITECTURE.md`.
3. Read the matching Python source and Python tests.
4. Identify whether the change is parity-preserving or an intentional divergence.

## Change Rules

- Public APIs need architecture-doc updates and behavioral tests.
- New or changed provider behavior needs parity notes when Python differs.
- New provider SDK usage must stay behind lazy imports and optional peer dependencies.
- Do not add live cloud calls to the default test suite.
- Do not add generated or build artifacts to a source change unless releasing.
- Do not broaden mocks so far that tests only prove the implementation was called.

## Review Loop

Every non-trivial change should leave behind enough evidence for another agent to audit:

- the user-visible behavior being changed,
- the Python source or documented divergence,
- the deterministic test that fails without the change,
- the command used to validate it.

If the right guardrail is missing, add it as close to the behavior as possible. Start
with a focused test; promote to lint or a script only when the pattern is recurring.
