/**
 * Applies pending Drizzle migrations, then exits. In AWS it runs as a one-off ECS task
 * (same image, command `node migrate/migrate.ts`) before a deploy, never at app start.
 * Node runs this file directly (type stripping), so it only imports runtime packages and
 * env-config.ts, and uses erasable TypeScript only.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { databaseConfigFromEnv } from "./env-config.ts";

// Any constant works; it just has to be the same for every runner of this app.
const MIGRATION_LOCK_ID = 740_112_001;

const log = (level: "info" | "error", msg: string, extra: object = {}) =>
  console[level](JSON.stringify({ level, msg, ...extra }));

export async function runMigrations(env: Record<string, string | undefined>, migrationsFolder: string) {
  const { connection, ssl } = databaseConfigFromEnv(env);
  const settings = { max: 1, ssl, onnotice: () => {} };
  const client = typeof connection === "string" ? postgres(connection, settings) : postgres({ ...connection, ...settings });
  try {
    // Two runners at once (e.g. a retried task) wait for each other instead of racing.
    await client`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
    await migrate(drizzle({ client }), { migrationsFolder });
    await client`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
  } finally {
    await client.end({ timeout: 5 });
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const folder = process.env.DRAFTPAGE_MIGRATIONS_DIR ?? new URL("../../../drizzle", import.meta.url).pathname;
  const started = Date.now();
  runMigrations(process.env, folder).then(
    () => log("info", "migrations applied", { folder, ms: Date.now() - started }),
    (error: unknown) => {
      // Never print the connection settings: they include the password.
      log("error", "migrations failed", { err: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    },
  );
}
