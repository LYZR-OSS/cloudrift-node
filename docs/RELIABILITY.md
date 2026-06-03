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
- Provider batch capacity is a contract boundary. If a provider has a hard batch limit,
  chunk deterministically or reject before sending. Do not silently drop messages when
  SDK capacity helpers such as Service Bus `tryAddMessage()` return `false`.
- Document operations are the exception: after `MongoClient` construction, operation
  failures remain native MongoDB driver errors.

## Optional Dependency Surface

- Lazy dynamic imports must be mirrored in `peerDependencies`, `peerDependenciesMeta`,
  and dev dependencies so installed packages and local tests resolve the same SDK names.
- Public declarations must not force consumers to install optional provider SDKs just to
  type-check CloudRift-owned APIs. Use structural CloudRift types at package boundaries.

## No Hidden Retries

Do not add package-level retry loops by default. Provider SDKs already have retry
behavior; Cloudrift should not multiply side effects for send, publish, delete, copy, or
secret writes unless the Python source adds that behavior first.
