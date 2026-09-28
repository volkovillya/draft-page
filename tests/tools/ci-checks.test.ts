import { describe, expect, it } from "vitest";
import { findLooseVersions } from "../../scripts/ci/check-exact-versions";
import { findEditedMigrations } from "../../scripts/ci/check-migrations";

describe("findLooseVersions", () => {
  it("accepts exact versions", () => {
    expect(findLooseVersions({ dependencies: { next: "16.3.6" }, devDependencies: { vitest: "5.0.1" } })).toEqual([]);
  });

  it("flags ranges, tags and pre-releases in every section", () => {
    expect(
      findLooseVersions({
        dependencies: { a: "^1.0.0", b: "~2.1.0" },
        devDependencies: { c: "latest", d: "3.0.0-rc.1" },
        optionalDependencies: { e: ">=1" },
      }),
    ).toEqual([
      "dependencies: a@^1.0.0",
      "dependencies: b@~2.1.0",
      "devDependencies: c@latest",
      "devDependencies: d@3.0.0-rc.1",
      "optionalDependencies: e@>=1",
    ]);
  });

  it("handles a package.json without dependency sections", () => {
    expect(findLooseVersions({ name: "x" })).toEqual([]);
  });
});

describe("findEditedMigrations", () => {
  it("allows a new migration and its journal entry", () => {
    const diff = "A\tdrizzle/0006_next.sql\nA\tdrizzle/meta/0006_snapshot.json\nM\tdrizzle/meta/_journal.json\n";
    expect(findEditedMigrations(diff)).toEqual([]);
  });

  it("flags edits and deletions of existing migrations and snapshots", () => {
    const diff = "M\tdrizzle/0003_ai_jobs.sql\nD\tdrizzle/meta/0001_snapshot.json\nA\tdrizzle/0003_renamed.sql\n";
    expect(findEditedMigrations(diff)).toEqual(["M drizzle/0003_ai_jobs.sql", "D drizzle/meta/0001_snapshot.json"]);
  });

  it("ignores files outside the migration folders", () => {
    expect(findEditedMigrations("M\tsrc/server/db/tables.ts\nM\tdrizzle.config.ts\n")).toEqual([]);
  });
});
