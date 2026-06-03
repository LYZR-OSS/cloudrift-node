/**
 * Cache module public surface and factory dispatch.
 *
 * Mirrors `cloudrift-py`'s `cloudrift.cache.get_cache`: an explicit two-arg
 * dispatch over `(provider, authMethod)`. The `authMethod` strings keep the
 * Python snake_case config names; they are mapped internally to the camelCase
 * static constructors. Unknown provider or method raises `CloudRiftError`.
 */
import { CloudRiftError } from "../core/errors.js";
import type { CacheBackend } from "./base.js";
import { StandaloneRedisBackend } from "./redisStandalone.js";
import { AWSElastiCacheBackend } from "./redisElasticache.js";
import { AzureRedisCacheBackend } from "./redisAzure.js";

export { CacheBackend } from "./base.js";
export type { CacheValue, CachePipeline } from "./base.js";
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
  let backend:
    | typeof StandaloneRedisBackend
    | typeof AWSElastiCacheBackend
    | typeof AzureRedisCacheBackend;

  if (provider === "redis") {
    backend = StandaloneRedisBackend;
  } else if (provider === "elasticache") {
    backend = AWSElastiCacheBackend;
  } else if (provider === "azure_redis") {
    backend = AzureRedisCacheBackend;
  } else {
    throw new CloudRiftError(
      `Unknown cache provider: ${JSON.stringify(provider)}. ` +
        "Choose 'redis', 'elasticache', or 'azure_redis'.",
    );
  }

  const factoryName = AUTH_METHOD_TO_FACTORY[authMethod];
  const factory = factoryName
    ? (backend as unknown as Record<string, unknown>)[factoryName]
    : undefined;

  if (typeof factory !== "function") {
    throw new CloudRiftError(`${backend.name} has no auth method ${JSON.stringify(authMethod)}.`);
  }

  return (factory as CacheBackendFactory).call(backend, options);
}
