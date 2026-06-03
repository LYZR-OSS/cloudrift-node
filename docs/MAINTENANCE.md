# Maintenance Rules

Use this checklist when changing `@lyzr/cloudrift`.

## Adding A Provider

- Add the provider adapter under the relevant `src/<domain>/` folder.
- Add factory routing in `src/<domain>/index.ts`.
- Add optional peer dependencies and peer metadata in `package.json`.
- Add lazy import errors that name the npm package to install.
- Add deterministic provider tests and update `ARCHITECTURE.md`.
- Add parity notes if Python does not have the provider.

## Adding A Method

- Add or update the abstract base class first.
- Check the Python method and tests for semantics.
- Implement every provider or throw a documented domain error when unsupported.
- Add contract tests and provider-specific tests.
- Update `README.md`, `ARCHITECTURE.md`, and `PARITY.md` if behavior differs from
  Python.

## Changing Provider Strings Or Auth Methods

Provider and auth strings are config contracts. Changing them is breaking unless an
alias preserves old behavior.

Required updates:

- factory tests,
- `ARCHITECTURE.md`,
- `PARITY.md` when Python differs,
- root README usage examples,
- release notes.

## Changing Exports

Update `package.json` exports, `src/index.ts`, subpath entry points, tests, and
`ARCHITECTURE.md` together. Do not rely on `dist/` as source.

## Optional Peers

Provider SDKs must remain optional peers. Do not move provider SDKs into runtime
dependencies unless the package intentionally stops being modular.

## Dist And Releases

`dist/` is generated output. Do not edit it by hand. Only include it in a release
artifact update after running the package build.

## Live Cloud Tests

Live cloud tests must be opt-in and skipped by default. They need explicit environment
guards, fake credentials in committed examples, unique resource naming, and cleanup.
