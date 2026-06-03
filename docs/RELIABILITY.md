# Reliability

Cloudrift is used at service boundaries. Reliability means predictable construction,
clear failure modes, reusable clients, and deterministic cleanup.

## Runtime Invariants

- Construct backends once at service startup and close them at shutdown.
- Lazy-load optional provider SDKs only when the provider is selected.
- Memoize AWS SDK client creation so concurrent first use does not create duplicate
  clients.
- Keep storage account clients separate from bucket/container views; only owning
  backends close shared clients.
- Translate provider errors at the adapter boundary and preserve the original error as
  `cause`.
- `healthCheck()` must be cheap and must return `false` on provider failure unless the
  domain contract explicitly says otherwise.

## Failure Policy

- Missing optional SDK: throw a CloudRift error that names the npm package to install.
- Not found: map to the domain not-found class where one exists.
- Permission/auth failure: map to the domain permission class where one exists.
- Send/publish batch partial failure: throw the domain send/publish error, not a generic
  base error.
- Document operations are the exception: after `MongoClient` construction, operation
  failures remain native MongoDB driver errors.

## No Hidden Retries

Do not add package-level retry loops by default. Provider SDKs already have retry
behavior; Cloudrift should not multiply side effects for send, publish, delete, copy, or
secret writes unless the Python source adds that behavior first.
