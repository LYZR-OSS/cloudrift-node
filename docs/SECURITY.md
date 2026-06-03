# Security

Cloudrift handles credentials, secrets, connection strings, and signed URLs. Security
rules are part of the package contract.

## Credentials

- Do not log credentials, connection strings, tokens, SAS URLs, presigned URLs, or secret
  values.
- Keep provider SDKs optional and loaded only when selected.
- Prefer provider-native credential chains when explicit credentials are absent.
- Preserve factory precedence documented in `ARCHITECTURE.md`; credential routing is
  behavior, not an implementation detail.

## Secrets

- Secret values are payloads, not metadata. Tests may use dummy strings, but production
  code must not expose them in thrown messages or logs.
- JSON secret parsing errors should identify the secret name only when doing so does not
  reveal sensitive content.
- Deleting an AWS secret uses force delete without recovery because that matches Python;
  callers are responsible for using it carefully.

## Signed URLs

- Presigned and SAS URLs are bearer credentials. Treat them as sensitive output.
- Tests may assert structural parameters such as expiry, path, or algorithm, but should
  not snapshot full signatures unless time and credentials are fixed.

## Agent Rules

Agents must not add real credentials, live account IDs, or cloud resource names to
fixtures. Use clearly fake values and local deterministic fakes.
