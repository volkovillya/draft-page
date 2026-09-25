import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "../helpers/env";

const run = promisify(execFile);
const RUNNER = fileURLToPath(new URL("../../src/server/db/migrate.ts", import.meta.url));
const DB_NAME = "draftpage_migrate_runner";

// The runner is executed exactly as in the image: plain `node` on the .ts file.
const migrateWith = (env: Record<string, string>) =>
  run(process.execPath, [RUNNER], { env: { NODE_ENV: "production", PATH: process.env.PATH ?? "", ...env } });

describe("migration runner (node migrate.ts)", () => {
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  const url = new URL(TEST_DATABASE_URL);
  const fields = {
    DRAFTPAGE_DB_HOST: url.hostname,
    DRAFTPAGE_DB_PORT: url.port,
    DRAFTPAGE_DB_NAME: DB_NAME,
    DRAFTPAGE_DB_USER: decodeURIComponent(url.username),
    DRAFTPAGE_DB_PASSWORD: decodeURIComponent(url.password),
  };

  beforeAll(async () => {
    await admin.unsafe(`drop database if exists ${DB_NAME}`);
    await admin.unsafe(`create database ${DB_NAME}`);
  });
  afterAll(async () => {
    await admin.unsafe(`drop database if exists ${DB_NAME} with (force)`);
    await admin.end();
  });

  it("applies every migration from separate DB_* variables, and is safe to run again", async () => {
    const first = await migrateWith(fields);
    expect(first.stdout).toContain('"msg":"migrations applied"');
    const second = await migrateWith(fields);
    expect(second.stdout).toContain('"msg":"migrations applied"');

    const db = postgres({ host: fields.DRAFTPAGE_DB_HOST, port: Number(fields.DRAFTPAGE_DB_PORT), database: DB_NAME, username: fields.DRAFTPAGE_DB_USER, password: fields.DRAFTPAGE_DB_PASSWORD, max: 1, onnotice: () => {} });
    try {
      const tables = await db`select table_name from information_schema.tables where table_schema = 'public' order by 1`;
      expect(tables.map((t) => t.table_name)).toEqual(["ai_jobs", "members", "messages", "outbox_events", "page_versions", "pages", "threads"]);
      const applied = await db`select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(applied[0]!.n).toBe(4);
    } finally {
      await db.end();
    }
  });

  it("exits non-zero with a clear message, without printing the password", async () => {
    const failure = await migrateWith({ ...fields, DRAFTPAGE_DB_PORT: "1", DRAFTPAGE_DB_PASSWORD: "hunter2-secret" }).then(
      () => null,
      (error: { code: number; stderr: string }) => error,
    );
    expect(failure?.code).toBe(1);
    expect(failure?.stderr).toContain('"msg":"migrations failed"');
    expect(failure?.stderr).not.toContain("hunter2-secret");
  });

  it("on RDS (rds_iam exists) creates draftpage_app with data access only", async () => {
    // Simulate RDS: rds_iam is a cluster-wide role, so everything is cleaned up afterwards.
    const scratch = `${DB_NAME}_rds`;
    await admin.unsafe(`drop database if exists ${scratch} with (force)`);
    await admin.unsafe(`create database ${scratch}`);
    await admin.unsafe(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'rds_iam') then create role rds_iam; end if; end $$`);
    try {
      await migrateWith({ ...fields, DRAFTPAGE_DB_NAME: scratch });
      const db = postgres({ host: fields.DRAFTPAGE_DB_HOST, port: Number(fields.DRAFTPAGE_DB_PORT), database: scratch, username: fields.DRAFTPAGE_DB_USER, password: fields.DRAFTPAGE_DB_PASSWORD, max: 1, onnotice: () => {} });
      try {
        const [role] = await db`select rolcanlogin, rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = 'draftpage_app'`;
        expect(role).toEqual({ rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false });
        const [member] = await db`select pg_has_role('draftpage_app', 'rds_iam', 'member') as ok`;
        expect(member!.ok).toBe(true);
        const privileges = await db`
          select table_name, string_agg(privilege_type, ',' order by privilege_type) as p
          from information_schema.role_table_grants where grantee = 'draftpage_app' group by 1 order by 1`;
        expect(privileges).toHaveLength(7);
        for (const row of privileges) expect(row.p).toBe("DELETE,INSERT,SELECT,UPDATE");
        // No DDL: it can't drop or alter tables.
        await db`set role draftpage_app`;
        await expect(db`drop table messages`).rejects.toThrow(/must be owner/);
        await db`reset role`;
      } finally {
        await db.end();
      }
    } finally {
      await admin.unsafe(`drop database if exists ${scratch} with (force)`);
      await admin.unsafe(`drop role if exists draftpage_app`);
      await admin.unsafe(`drop role if exists rds_iam`);
    }
  });
});
