// Fails when a change edits or removes a migration that already exists on the base commit.
// New migrations (and the journal entry that lists them) are fine.
// Run: node scripts/ci/check-migrations.ts <base-commit>
import { execFileSync } from "node:child_process";

const LOCKED = /^drizzle\/(\d{4}_[^/]+\.sql|meta\/\d{4}_snapshot\.json)$/;

/** `nameStatus` is `git diff --name-status --no-renames` output (renames show up as D + A). */
export function findEditedMigrations(nameStatus: string): string[] {
  return nameStatus
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([status, path]) => status !== "A" && path !== undefined && LOCKED.test(path))
    .map(([status, path]) => `${status} ${path}`);
}

if (import.meta.main) {
  const base = process.argv[2];
  if (!base) {
    console.error("usage: node scripts/ci/check-migrations.ts <base-commit>");
    process.exit(2);
  }
  const diff = execFileSync("git", ["diff", "--name-status", "--no-renames", base, "HEAD", "--", "drizzle"], {
    encoding: "utf8",
  });
  const edited = findEditedMigrations(diff);
  if (edited.length > 0) {
    console.error("Applied migrations are immutable; add a new migration instead:");
    for (const line of edited) console.error(`  ${line}`);
    process.exit(1);
  }
}
