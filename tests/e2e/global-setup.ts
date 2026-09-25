import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const E2E_DATABASE_URL =
  process.env.DRAFTPAGE_E2E_DATABASE_URL ?? "postgres://postgres:test@localhost:55440/draftpage_e2e";

/** Creates (if needed) and migrates a dedicated e2e database on the disposable test server. */
export default async function globalSetup() {
  const url = new URL(E2E_DATABASE_URL);
  const name = url.pathname.slice(1);
  const admin = postgres({ ...parts(url), database: "postgres", max: 1 });
  try {
    const exists = await admin`select 1 from pg_database where datname = ${name}`;
    if (exists.length === 0) await admin.unsafe(`create database "${name.replace(/"/g, "")}"`);
  } catch (error) {
    throw new Error(`E2E needs the test database server. Start it with: npm run test:db\n${String(error)}`);
  } finally {
    await admin.end();
  }
  const client = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  await migrate(drizzle({ client }), { migrationsFolder: "./drizzle" });
  // Every run starts from an empty e2e database (never the dev database).
  await client`truncate table outbox_events, pages, members restart identity cascade`;
  await client.end();
}

function parts(url: URL) {
  return { host: url.hostname, port: Number(url.port || 5432), username: url.username, password: url.password };
}
