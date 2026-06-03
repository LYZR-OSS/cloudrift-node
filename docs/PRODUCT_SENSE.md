# Product Sense

Cloudrift exists so Lyzr services can choose cloud infrastructure providers at
deployment time without rewriting application code.

## What It Is

- A small async abstraction over storage, queues, document databases, cache, secrets,
  and pub/sub.
- A portability layer for AWS, Azure, and self-hosted Redis where the semantics are
  compatible enough to share an API.
- A package that makes provider differences explicit when they affect correctness,
  cost, lifecycle, or security.

## What It Is Not

- Not an ORM.
- Not a worker framework.
- Not an application platform.
- Not a migration tool.
- Not a promise that all cloud providers behave identically.

## Design Pressure

Favor predictable service code over clever abstraction. Provider differences should be
visible in docs, option names, errors, or intentional divergences. Do not hide behavior
that a service owner must understand to operate safely.
