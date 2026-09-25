import { defineConfig } from "drizzle-kit";

try {
  process.loadEnvFile(".env.local");
} catch {
  // No local env file (CI, containers): rely on the real environment.
}

export default defineConfig({
  schema: "./src/server/db/tables.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DRAFTPAGE_DATABASE_URL ?? "" },
  strict: true,
});
