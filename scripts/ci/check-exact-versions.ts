// Fails when a dependency in package.json isn't pinned to one exact, stable version
// (no ^ ~ ranges, tags or pre-releases). Run: node scripts/ci/check-exact-versions.ts
import { readFileSync } from "node:fs";

const EXACT = /^\d+\.\d+\.\d+$/;
const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

export function findLooseVersions(pkg: Record<string, unknown>): string[] {
  const loose: string[] = [];
  for (const section of SECTIONS) {
    const deps = (pkg[section] ?? {}) as Record<string, string>;
    for (const [name, spec] of Object.entries(deps)) {
      if (!EXACT.test(spec)) loose.push(`${section}: ${name}@${spec}`);
    }
  }
  return loose;
}

if (import.meta.main) {
  const loose = findLooseVersions(JSON.parse(readFileSync("package.json", "utf8")));
  if (loose.length > 0) {
    console.error("Pin these to an exact stable version (npm install --save-exact):");
    for (const line of loose) console.error(`  ${line}`);
    process.exit(1);
  }
}
