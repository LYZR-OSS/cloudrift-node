/**
 * Relational SQL connection + authentication factory.
 *
 * cloudrift's SQL layer abstracts how you *connect and authenticate* to a
 * relational database across clouds — static credentials, AWS RDS/Aurora IAM
 * tokens, and Azure AD / Entra tokens — and hands back a fully-authenticated
 * **native driver connection**. It deliberately does NOT abstract query
 * execution, SQL dialects, or schema introspection: those belong to the
 * application, which uses the returned connection's native API directly.
 *
 * Mirrors `cloudrift-py`'s `cloudrift.sql.get_sql`: an explicit two-arg dispatch
 * over `(provider, authMethod)` (same shape as `getCache`). The `authMethod`
 * strings keep the Python snake_case names; they are mapped internally to the
 * camelCase static constructors. Unknown provider or method raises
 * `CloudRiftError`.
 */
import { CloudRiftError } from "../core/errors.js";
import { normalizeChoice } from "../core/providers.js";
import { type SQLBackend } from "./base.js";
import { PostgresSQLBackend, RedshiftSQLBackend } from "./postgresql.js";
import { MySQLSQLBackend } from "./mysql.js";
import { MSSQLSQLBackend } from "./mssql.js";
import { OracleSQLBackend } from "./oracle.js";
import { DatabricksSQLBackend } from "./databricks.js";

export { SQLBackend } from "./base.js";
export type { SqlConnection } from "./base.js";
export { PostgresSQLBackend, RedshiftSQLBackend } from "./postgresql.js";
export type {
  PostgresCredentialsOptions,
  PostgresUrlOptions,
  PostgresIamAuthOptions,
} from "./postgresql.js";
export { MySQLSQLBackend } from "./mysql.js";
export type { MySqlCredentialsOptions, MySqlUrlOptions, MySqlIamAuthOptions } from "./mysql.js";
export { MSSQLSQLBackend } from "./mssql.js";
export type {
  MssqlCredentialsOptions,
  MssqlServicePrincipalOptions,
  MssqlManagedIdentityOptions,
  TokenProvider,
} from "./mssql.js";
export { OracleSQLBackend } from "./oracle.js";
export type { OracleCredentialsOptions } from "./oracle.js";
export { DatabricksSQLBackend } from "./databricks.js";
export type { DatabricksTokenOptions } from "./databricks.js";
export { parseSqlUrl, buildSqlalchemyUrl } from "./url.js";
export type { ParsedSqlUrl, SqlalchemyUrlParts } from "./url.js";
export { validatePinnedCertificate } from "./mssqlTls.js";

export type SqlProvider =
  | "postgres"
  | "postgresql"
  | "redshift"
  | "mysql"
  | "mssql"
  | "azuresql"
  | "sqlserver"
  | "oracle"
  | "databricks";

/** Canonical provider keys after alias normalization. */
type CanonicalProvider = "postgres" | "redshift" | "mysql" | "mssql" | "oracle" | "databricks";

const SQL_PROVIDERS = [
  "postgres",
  "redshift",
  "mysql",
  "mssql",
  "oracle",
  "databricks",
] as const satisfies readonly CanonicalProvider[];

const PROVIDER_ALIASES: Partial<Record<string, CanonicalProvider>> = {
  postgresql: "postgres",
  azuresql: "mssql",
  sqlserver: "mssql",
};

/** snake_case auth-method config value → camelCase static constructor name. */
const AUTH_METHOD_TO_FACTORY: Record<string, string> = {
  from_credentials: "fromCredentials",
  from_url: "fromUrl",
  from_iam_auth: "fromIamAuth",
  from_entra_service_principal: "fromEntraServicePrincipal",
  from_entra_managed_identity: "fromEntraManagedIdentity",
  from_token: "fromToken",
};

type SqlBackendClass = {
  name: string;
};
type SqlBackendFactory = (options: Record<string, unknown>) => SQLBackend;

/**
 * Instantiate a SQL connection backend.
 *
 * @param provider   One of `postgres`/`postgresql`, `redshift`, `mysql`,
 *   `mssql`/`azuresql`/`sqlserver`, `oracle`, `databricks`.
 * @param authMethod The snake_case factory method (e.g. `"from_credentials"`,
 *   `"from_iam_auth"`, `"from_entra_service_principal"`).
 * @param options    Arguments forwarded to the chosen factory method.
 */
export function getSql(
  provider: SqlProvider | string,
  authMethod: string,
  options: Record<string, unknown>,
): SQLBackend {
  const normalizedProvider = normalizeChoice(
    "SQL provider",
    provider,
    SQL_PROVIDERS,
    PROVIDER_ALIASES,
  );

  let backend: SqlBackendClass;
  switch (normalizedProvider) {
    case "postgres":
      backend = PostgresSQLBackend;
      break;
    case "redshift":
      backend = RedshiftSQLBackend;
      break;
    case "mysql":
      backend = MySQLSQLBackend;
      break;
    case "mssql":
      backend = MSSQLSQLBackend;
      break;
    case "oracle":
      backend = OracleSQLBackend;
      break;
    case "databricks":
      backend = DatabricksSQLBackend;
      break;
  }

  const factoryName = AUTH_METHOD_TO_FACTORY[authMethod.trim().toLowerCase()];
  const factory = factoryName
    ? (backend as unknown as Record<string, unknown>)[factoryName]
    : undefined;

  if (typeof factory !== "function") {
    throw new CloudRiftError(`${backend.name} has no auth method ${JSON.stringify(authMethod)}.`);
  }

  return (factory as SqlBackendFactory).call(backend, options);
}
