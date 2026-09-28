import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Made-up names: the real list is private and must never appear in the repo.
const SCRIPT = resolve("scripts/check-banned-names.sh");
let repo: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });

function check(args: string[], env: Record<string, string> = {}) {
  const { BANNED_NAMES_PATTERN: _unset, ...base } = process.env;
  const result = spawnSync("bash", [SCRIPT, ...args], { cwd: repo, env: { ...base, ...env }, encoding: "utf8" });
  return { code: result.status, stderr: result.stderr };
}

function stage(file: string, text: string) {
  writeFileSync(join(repo, file), text);
  git("add", file);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "banned-names-"));
  git("init", "-q");
  writeFileSync(join(repo, ".git/info/banned-names"), "# private\nacmecorp\nzorblax\n\n");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("check-banned-names.sh", () => {
  it("passes clean staged files", () => {
    stage("a.ts", "export const page = 1;\n");
    expect(check(["--staged"]).code).toBe(0);
  });

  it("blocks a staged name case-insensitively and prints only file:line", () => {
    stage("a.ts", "ok\n// made by AcmeCorp\n");
    const { code, stderr } = check(["--staged"]);
    expect(code).toBe(1);
    expect(stderr).toContain("a.ts:2");
    expect(stderr.toLowerCase()).not.toContain("acmecorp");
  });

  it("matches whole words only", () => {
    stage("a.ts", "const acmecorporate = 'zorblaxes';\n");
    expect(check(["--staged"]).code).toBe(0);
  });

  it("checks what is staged, not the working copy", () => {
    stage("a.ts", "zorblax\n");
    writeFileSync(join(repo, "a.ts"), "clean\n");
    expect(check(["--staged"]).code).toBe(1);
  });

  it("checks tracked files with --all", () => {
    stage("a.ts", "clean\n");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
    writeFileSync(join(repo, "a.ts"), "zorblax\n");
    expect(check(["--all"]).code).toBe(1);
  });

  it("checks a commit message, ignoring git's comment lines", () => {
    const msg = join(repo, "MSG");
    writeFileSync(msg, "Add pages\n# zorblax in a comment line\n");
    expect(check(["--message", msg]).code).toBe(0);
    writeFileSync(msg, "Port the zorblax editor\n");
    expect(check(["--message", msg]).code).toBe(1);
  });

  it("uses BANNED_NAMES_PATTERN when set (CI)", () => {
    stage("a.ts", "hello widgetco\n");
    expect(check(["--staged"]).code).toBe(0);
    expect(check(["--staged"], { BANNED_NAMES_PATTERN: "widgetco|other" }).code).toBe(1);
  });

  it("fails closed when no names are configured", () => {
    rmSync(join(repo, ".git/info/banned-names"));
    stage("a.ts", "clean\n");
    expect(check(["--staged"]).code).toBe(2);
  });
});
