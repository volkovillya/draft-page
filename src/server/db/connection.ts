import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Signer } from "@aws-sdk/rds-signer";
import postgres from "postgres";
import { databaseConfigFromEnv, type ConnectionFields, type SslMode } from "./env-config";
import * as tables from "./tables";

export type Db = PostgresJsDatabase<typeof tables>;
/** An open transaction, for core helpers that must run inside a caller's transaction. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(
  connection: string | (Omit<ConnectionFields, "password"> & { password: string | (() => Promise<string>) }),
  options: { ssl?: boolean | SslMode; max?: number } = {},
): {
  db: Db;
  close: () => Promise<void>;
} {
  const ssl = options.ssl === true ? "require" : (options.ssl ?? false);
  const settings = { max: options.max ?? 5, ssl, idle_timeout: 30 };
  const client = typeof connection === "string" ? postgres(connection, settings) : postgres({ ...connection, ...settings });
  return { db: drizzle({ client, schema: tables }), close: () => client.end({ timeout: 5 }) };
}

// One pool per server process. Cached on globalThis so dev hot-reload doesn't leak pools.
const cache = globalThis as typeof globalThis & { __draftpageDb?: Db };

export function getDb(): Db {
  if (!cache.__draftpageDb) {
    const config = databaseConfigFromEnv(process.env);
    const connection = config.iamAuth
      ? { ...config.connection, password: iamTokenProvider(config.connection, process.env.AWS_REGION) }
      : config.connection;
    cache.__draftpageDb = createDb(connection, { ssl: config.ssl }).db;
  }
  return cache.__draftpageDb;
}

/**
 * IAM database authentication (decision D10): postgres.js calls this for every new
 * connection, and it returns a signed token valid for 15 minutes, created from the task
 * role's credentials. There is no stored password to rotate.
 */
function iamTokenProvider(target: { host: string; port: number; username: string }, region: string | undefined) {
  if (!region) throw new Error("AWS_REGION must be set for IAM database authentication");
  const signer = new Signer({ hostname: target.host, port: target.port, username: target.username, region });
  return () => signer.getAuthToken();
}
