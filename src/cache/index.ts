/**
 * Cache module public surface and factory dispatch.
 *
 * Mirrors `cloudrift-py`'s `cloudrift.cache.get_cache`: an explicit two-arg
 * dispatch over `(provider, authMethod)`. The `authMethod` strings keep the
 * Python snake_case config names; they are mapped internally to the camelCase
 * static constructors. Unknown provider or method raises `CloudRiftError`.
 */
import { CloudRiftError } from "../core/errors.js";
import { normalizeChoice } from "../core/providers.js";
import type { CacheBackend } from "./base.js";
import { StandaloneRedisBackend } from "./redisStandalone.js";
import { AWSElastiCacheBackend } from "./redisElasticache.js";
import { AzureRedisCacheBackend } from "./redisAzure.js";

export { CacheBackend } from "./base.js";
export type { CacheValue, CacheReadValue, CachePipeline, ExpireOptions } from "./base.js";
export { BaseRedisBackend } from "./redisBase.js";
export { StandaloneRedisBackend } from "./redisStandalone.js";
export { AWSElastiCacheBackend, generateElastiCacheIamToken } from "./redisElasticache.js";
export type { IamTokenParams } from "./redisElasticache.js";
export { AzureRedisCacheBackend } from "./redisAzure.js";

export type CacheProvider = "redis" | "elasticache" | "azure_redis";
export type CacheAuthMethod =
  | "from_url"
  | "from_credentials"
  | "from_tls_cert"
  | "from_auth_token"
  | "from_iam_auth"
  | "from_access_key"
  | "from_managed_identity"
  | "from_service_principal";

const CACHE_PROVIDERS = [
  "redis",
  "elasticache",
  "azure_redis",
] as const satisfies readonly CacheProvider[];

/**
 * Percent-encode a password for use in a Redis URL userinfo component,
 * matching Python's `urllib.parse.quote(password, safe='')`.
 *
 * `encodeURIComponent` leaves `! * ' ( )` unescaped, but Python's `quote`
 * with `safe=''` encodes them, so we escape those five characters explicitly
 * to keep the produced URL byte-for-byte identical to `cloudrift-py`.
 */
function quotePassword(password: string): string {
  return encodeURIComponent(password).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** TLS verification modes accepted by {@link cacheBrokerUrl}. */
export type SslCertReqs = "CERT_NONE" | "CERT_OPTIONAL" | "CERT_REQUIRED";

const VALID_SSL_CERT_REQS: readonly SslCertReqs[] = ["CERT_NONE", "CERT_OPTIONAL", "CERT_REQUIRED"];

/**
 * Return a Redis URL (`redis://` or `rediss://`) suitable for clients that
 * require URL-based configuration — most notably Celery, which cannot consume a
 * {@link CacheBackend} directly.
 *
 * Mirrors `cloudrift-py`'s `cache_broker_url()`.
 *
 * @param opts.provider     `"redis"` (self-hosted), `"elasticache"` (AWS), or
 *                          `"azure_redis"`.
 * @param opts.host         Redis host.
 * @param opts.port         Redis port (6379 plain, 6380 TLS, 10000 for some
 *                          Azure tiers — pass what the cluster listens on).
 * @param opts.password     Optional. Omit (or pass `""`) for unauthenticated
 *                          self-hosted Redis; for cloud providers this is the
 *                          AUTH token / access key.
 * @param opts.db           Redis database index (default `0`).
 * @param opts.sslCertReqs  TLS verification mode for cloud providers. One of
 *                          `CERT_NONE` / `CERT_OPTIONAL` / `CERT_REQUIRED`
 *                          (default `CERT_NONE`). Ignored when
 *                          `provider === "redis"`.
 *
 * Token-based auth (ElastiCache IAM, Azure Managed Identity / Service
 * Principal) cannot be expressed in a static URL — configure the consumer with
 * a credential provider instead.
 *
 * Note: invalid `sslCertReqs`, a non-integer/negative `db`, or an unsupported
 * provider throw {@link CloudRiftError} (Python raises `ValueError`).
 */
export function cacheBrokerUrl(opts: {
  provider: CacheProvider | string;
  host: string;
  port: number;
  password?: string;
  db?: number;
  sslCertReqs?: SslCertReqs | string;
}): string {
  const password = opts.password ?? "";
  const db = opts.db ?? 0;
  const sslCertReqs = opts.sslCertReqs ?? "CERT_NONE";

  // Validate eagerly so a bad value fails at the call site rather than at
  // connection time — applies to every provider, even where it's unused.
  if (!VALID_SSL_CERT_REQS.includes(sslCertReqs as SslCertReqs)) {
    throw new CloudRiftError(
      `Invalid sslCertReqs: ${JSON.stringify(sslCertReqs)}. ` +
        `Must be one of: ${VALID_SSL_CERT_REQS.join(", ")}.`,
    );
  }
  if (!Number.isInteger(db) || db < 0) {
    throw new CloudRiftError(`Invalid db: ${JSON.stringify(db)}. Must be a non-negative integer.`);
  }

  // When a password is present, include the `default` username so the URL is
  // valid against Redis 6+ ACL deployments (`redis://default:pw@host`). The
  // password is percent-encoded so special characters don't corrupt the URL.
  const auth = password ? `default:${quotePassword(password)}@` : "";

  if (opts.provider === "redis") {
    return `redis://${auth}${opts.host}:${opts.port}/${db}`;
  }
  if (opts.provider === "elasticache" || opts.provider === "azure_redis") {
    return `rediss://${auth}${opts.host}:${opts.port}/${db}?ssl_cert_reqs=${sslCertReqs}`;
  }
  throw new CloudRiftError(
    `Unsupported cache provider for broker URL: ${JSON.stringify(opts.provider)}. ` +
      "Must be one of: 'redis', 'elasticache', 'azure_redis'.",
  );
}

/** snake_case auth-method config value → camelCase static constructor name. */
const AUTH_METHOD_TO_FACTORY: Record<string, string> = {
  from_url: "fromUrl",
  from_credentials: "fromCredentials",
  from_tls_cert: "fromTlsCert",
  from_auth_token: "fromAuthToken",
  from_iam_auth: "fromIamAuth",
  from_access_key: "fromAccessKey",
  from_managed_identity: "fromManagedIdentity",
  from_service_principal: "fromServicePrincipal",
};

type CacheBackendFactory = (options: Record<string, unknown>) => Promise<CacheBackend>;

/**
 * Instantiate a cache backend.
 *
 * @param provider   `"redis"`, `"elasticache"`, or `"azure_redis"`.
 * @param authMethod The snake_case factory method (e.g. `"from_credentials"`).
 * @param options    Arguments forwarded to the chosen factory method.
 */
export async function getCache(
  provider: CacheProvider | string,
  authMethod: CacheAuthMethod | string,
  options: Record<string, unknown>,
): Promise<CacheBackend> {
  const normalizedProvider = normalizeChoice("cache provider", provider, CACHE_PROVIDERS);
  const normalizedAuthMethod = authMethod.trim().toLowerCase();

  let backend:
    | typeof StandaloneRedisBackend
    | typeof AWSElastiCacheBackend
    | typeof AzureRedisCacheBackend;

  switch (normalizedProvider) {
    case "redis":
      backend = StandaloneRedisBackend;
      break;
    case "elasticache":
      backend = AWSElastiCacheBackend;
      break;
    case "azure_redis":
      backend = AzureRedisCacheBackend;
      break;
  }

  const factoryName = AUTH_METHOD_TO_FACTORY[normalizedAuthMethod];
  const factory = factoryName
    ? (backend as unknown as Record<string, unknown>)[factoryName]
    : undefined;

  if (typeof factory !== "function") {
    throw new CloudRiftError(
      `${backend.name} has no auth method ${JSON.stringify(normalizedAuthMethod)}.`,
    );
  }

  return (factory as CacheBackendFactory).call(backend, options);
}
