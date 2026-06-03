# Plans

Use plans for changes that span more than one domain, alter public APIs, or intentionally
diverge from Python.

## Lightweight Plan Template

```md
# <title>

## Goal

## Source Of Truth

## Steps

## Verification

## Decision Log
```

Store active plans under `docs/exec-plans/active/` and move completed plans to
`docs/exec-plans/completed/`. Small debt items belong in
`docs/exec-plans/tech-debt-tracker.md`.

Plans are not substitutes for tests. A plan is complete only when the code, docs, and
verification evidence are complete.
