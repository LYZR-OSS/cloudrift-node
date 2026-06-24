// Root entry point for @lyzr/cloudrift.
//
// Mirrors the Python package's top-level __init__.py: re-exports the full
// public surface — every factory function, backend/client class, error class,
// and public type. See ARCHITECTURE.md section 4.8.
//
// Notes on conflict handling:
// - The unified error tree and the `loadOptional` helper come from ./core.
// - The shared AWS option types (`AwsClientOptions`, `AwsAccessKeyOptions`,
//   `AwsIamRoleOptions`, `AwsProfileOptions`) are declared in both ./storage
//   and ./secrets. To avoid an ambiguous re-export they are surfaced once here
//   (from ./storage, the canonical definition per ARCHITECTURE 4.2). The
//   storage and secrets `export *` lines below would otherwise both try to
//   re-export these names; we re-export the rest explicitly to keep the root
//   surface unambiguous.

// --- core: error tree + lazy loader ---
export * from "./core/index.js";

// --- storage ---
export {
  StorageBackend,
  AWSS3Backend,
  AWSS3Client,
  AzureBlobBackend,
  AzureBlobClient,
  getStorage,
  getStorageClient,
} from "./storage/index.js";
export type {
  BinaryInput,
  ObjectMetadata,
  StorageProvider,
  AwsClientOptions,
  AwsAccessKeyOptions,
  AwsIamRoleOptions,
  AwsProfileOptions,
} from "./storage/index.js";

// --- messaging ---
export {
  MessagingBackend,
  AWSSQSBackend,
  AzureServiceBusBackend,
  getQueue,
} from "./messaging/index.js";
export type {
  Message,
  QueueProvider,
  SendOptions as MessagingSendOptions,
  SendBatchOptions,
  ReceiveOptions,
} from "./messaging/index.js";

// --- cache ---
export {
  CacheBackend,
  BaseRedisBackend,
  StandaloneRedisBackend,
  AWSElastiCacheBackend,
  AzureRedisCacheBackend,
  generateElastiCacheIamToken,
  getCache,
  cacheBrokerUrl,
} from "./cache/index.js";
export type {
  CacheValue,
  CacheReadValue,
  CachePipeline,
  CacheProvider,
  CacheAuthMethod,
  ExpireOptions,
  SslCertReqs,
  IamTokenParams,
} from "./cache/index.js";

// --- secrets ---
export {
  SecretBackend,
  AWSSecretsManagerBackend,
  AzureKeyVaultBackend,
  EnvSecretBackend,
  FileSecretBackend,
  MappingSecretBackend,
  getSecrets,
} from "./secrets/index.js";
export type { SecretsProvider } from "./secrets/index.js";

// --- pubsub ---
export { PubSubBackend, AWSSNSBackend, AzureEventGridBackend, getPubsub } from "./pubsub/index.js";
export type { PubSubMessage, PubSubProvider } from "./pubsub/index.js";

// --- document ---
export {
  connectUri,
  connectCredentials,
  connectTlsCert,
  connectConnectionString,
  connectAccountKey,
  getMongodb,
  setDocumentDbClientConstructor,
  setCosmosClientConstructor,
} from "./document/index.js";
export type { DocumentProvider, MongoClientConstructor, PoolOptions } from "./document/index.js";

// --- email ---
export {
  EmailBackend,
  AWSSESBackend,
  AzureACSEmailBackend,
  SMTPEmailBackend,
  getEmail,
} from "./email/index.js";
export type {
  EmailProvider,
  Attachment,
  EmailMessage,
  SendOptions as EmailSendOptions,
  SesClientOptions,
  SesAccessKeyOptions,
  SesIamRoleOptions,
  SesProfileOptions,
  AcsConnectionStringOptions,
  AcsManagedIdentityOptions,
  AcsServicePrincipalOptions,
  SmtpBaseOptions,
  SmtpAuthOptions,
} from "./email/index.js";

// --- sql ---
export {
  SQLBackend,
  PostgresSQLBackend,
  RedshiftSQLBackend,
  MySQLSQLBackend,
  MSSQLSQLBackend,
  OracleSQLBackend,
  DatabricksSQLBackend,
  getSql,
  parseSqlUrl,
  buildSqlalchemyUrl,
  validatePinnedCertificate,
} from "./sql/index.js";
export type {
  SqlConnection,
  SqlProvider,
  PostgresCredentialsOptions,
  PostgresUrlOptions,
  PostgresIamAuthOptions,
  MySqlCredentialsOptions,
  MySqlUrlOptions,
  MySqlIamAuthOptions,
  MssqlCredentialsOptions,
  MssqlServicePrincipalOptions,
  MssqlManagedIdentityOptions,
  TokenProvider,
  OracleCredentialsOptions,
  DatabricksTokenOptions,
  ParsedSqlUrl,
  SqlalchemyUrlParts,
} from "./sql/index.js";
