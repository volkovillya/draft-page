/**
 * Database settings from the environment. Shared by the app (connection.ts) and the
 * migration runner (migrate.ts), which Node runs directly, so this file must stay plain,
 * erasable TypeScript with no imports.
 *
 * Two ways to configure it:
 * - Local: DRAFTPAGE_DATABASE_URL=postgres://user:pass@host:port/db
 * - AWS:   DRAFTPAGE_DB_HOST, DRAFTPAGE_DB_PORT, DRAFTPAGE_DB_NAME, DRAFTPAGE_DB_USER,
 *          DRAFTPAGE_DB_PASSWORD. ECS injects the user and password from the RDS-managed
 *          secret; nobody ever builds a URL containing the password by hand.
 *
 * DRAFTPAGE_DB_IAM_AUTH=true (AWS, the app only): sign in as DRAFTPAGE_DB_USER with a
 * short-lived IAM token instead of a password (decision D10), so there is no password to
 * rotate or leak. Requires DRAFTPAGE_DATABASE_SSL=verify-full (or require).
 *
 * DRAFTPAGE_DATABASE_SSL: "false" (default) | "require" (encrypted, certificate not checked)
 * | "verify-full" (encrypted and the server certificate and hostname are verified against
 * the trusted CAs; the image adds the RDS CA bundle via NODE_EXTRA_CA_CERTS). "true" is an
 * alias of "require".
 */

export type SslMode = false | "require" | "verify-full";

export type ConnectionFields = {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
};

export type DatabaseConfig =
  | { connection: string | ConnectionFields; ssl: SslMode; iamAuth?: false }
  /** No password: connection.ts fetches a fresh IAM auth token for every new connection. */
  | { connection: Omit<ConnectionFields, "password">; ssl: Exclude<SslMode, false>; iamAuth: true };

type Env = Record<string, string | undefined>;

export function sslModeFromEnv(value: string | undefined): SslMode {
  switch (value ?? "") {
    case "":
    case "false":
      return false;
    case "true":
    case "require":
      return "require";
    case "verify-full":
      return "verify-full";
    default:
      throw new Error(`DRAFTPAGE_DATABASE_SSL must be false, require or verify-full (got "${value}")`);
  }
}

export function databaseConfigFromEnv(env: Env): DatabaseConfig {
  const ssl = sslModeFromEnv(env.DRAFTPAGE_DATABASE_SSL);
  const url = env.DRAFTPAGE_DATABASE_URL;
  if (url) return { connection: url, ssl };

  const iamAuth = env.DRAFTPAGE_DB_IAM_AUTH === "true";
  const host = env.DRAFTPAGE_DB_HOST;
  const database = env.DRAFTPAGE_DB_NAME;
  const username = env.DRAFTPAGE_DB_USER;
  const password = env.DRAFTPAGE_DB_PASSWORD;
  const required: Record<string, string | undefined> = {
    DRAFTPAGE_DB_HOST: host,
    DRAFTPAGE_DB_NAME: database,
    DRAFTPAGE_DB_USER: username,
  };
  if (!iamAuth) required.DRAFTPAGE_DB_PASSWORD = password;
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Database is not configured: set DRAFTPAGE_DATABASE_URL, or ${missing.join(", ")}`);
  }

  const rawPort = env.DRAFTPAGE_DB_PORT || "5432";
  const port = Number(rawPort);
  if (!/^\d{1,5}$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error(`DRAFTPAGE_DB_PORT must be a port number (got "${rawPort}")`);
  }
  if (iamAuth) {
    if (!ssl) throw new Error("DRAFTPAGE_DB_IAM_AUTH requires DRAFTPAGE_DATABASE_SSL=verify-full");
    return { connection: { host: host!, port, database: database!, username: username! }, ssl, iamAuth: true };
  }
  return { connection: { host: host!, port, database: database!, username: username!, password: password! }, ssl };
}
