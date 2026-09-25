import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { TEST_DATABASE_URL } from "./env";

/** Rebuilds the test database schema from the Drizzle migrations once per test run. */
export default async function setup(): Promise<void> {
  const client = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {}, connect_timeout: 5 });
  try {
    try {
      await client`select 1`;
    } catch (error) {
      throw new Error(
        `Can't connect to the test database at ${TEST_DATABASE_URL} (${(error as Error).message}). ` +
          `Start it with: npm run test:db`,
      );
    }
    await client.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await client.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE;");
    await migrate(drizzle({ client }), {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}
