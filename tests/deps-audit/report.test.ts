import { describe, expect, it } from "vitest";
import {
  AuditUnavailable,
  buildReport,
  issueBody,
  MARKER,
  MAX_ROWS,
  parseAudit,
  prComment,
  stepSummary,
  updatesMainIssue,
  type AuditJson,
  type Lockfile,
  type Severity,
} from "../../scripts/deps-audit/report";

const advisory = (title: string, severity: Severity, range = "<1.2.0") => ({
  source: 1,
  name: "x",
  dependency: "x",
  title,
  url: `https://github.com/advisories/GHSA-${title}`,
  severity,
  range,
});

// The shape npm 11 prints: esbuild (a dev tool's dependency) flagged through a chain of packages,
// where npm's only "fix" is a downgrade of the direct dependency.
const DEV_CHAIN: AuditJson = {
  vulnerabilities: {
    esbuild: {
      name: "esbuild",
      severity: "moderate",
      isDirect: false,
      via: [advisory("dev-server", "moderate", "<=0.24.2")],
      effects: ["@esbuild-kit/core-utils"],
      range: "<=0.24.2",
      nodes: ["node_modules/@esbuild-kit/core-utils/node_modules/esbuild"],
      fixAvailable: { name: "drizzle-kit", version: "0.18.1", isSemVerMajor: true },
    },
    "@esbuild-kit/core-utils": {
      name: "@esbuild-kit/core-utils",
      severity: "moderate",
      isDirect: false,
      via: ["esbuild"],
      effects: ["drizzle-kit"],
      range: "*",
      nodes: ["node_modules/@esbuild-kit/core-utils"],
      fixAvailable: { name: "drizzle-kit", version: "0.18.1", isSemVerMajor: true },
    },
    "drizzle-kit": {
      name: "drizzle-kit",
      severity: "moderate",
      isDirect: true,
      via: ["@esbuild-kit/core-utils"],
      effects: [],
      range: "0.19.0 - 1.0.0",
      nodes: ["node_modules/drizzle-kit"],
      fixAvailable: { name: "drizzle-kit", version: "0.18.1", isSemVerMajor: true },
    },
  },
};

const LOCK: Lockfile = {
  packages: {
    "node_modules/@esbuild-kit/core-utils/node_modules/esbuild": { version: "0.18.20", dev: true },
    "node_modules/@esbuild-kit/core-utils": { version: "3.3.2", dev: true },
    "node_modules/drizzle-kit": { version: "0.31.11", dev: true },
    "node_modules/postgres": { version: "3.4.9" },
    "node_modules/next": { version: "16.3.6" },
  },
};

const prodDirect = (severity: Severity, fixAvailable: unknown = { name: "postgres", version: "3.4.10", isSemVerMajor: false }) =>
  ({
    vulnerabilities: {
      postgres: {
        name: "postgres",
        severity,
        isDirect: true,
        via: [advisory("sql", severity)],
        effects: [],
        range: "<3.4.10",
        nodes: ["node_modules/postgres"],
        fixAvailable,
      },
    },
  }) as AuditJson;

describe("parseAudit", () => {
  it("rejects output that isn't a report", () => {
    expect(() => parseAudit("npm ERR! network")).toThrow(AuditUnavailable);
    expect(() => parseAudit(JSON.stringify({ error: { code: "ENOTFOUND" } }))).toThrow(AuditUnavailable);
  });

  it("accepts a clean report", () => {
    expect(parseAudit(JSON.stringify({ vulnerabilities: {}, metadata: {} })).vulnerabilities).toEqual({});
  });
});

describe("buildReport", () => {
  it("makes one row per advisory, credits the direct dependency, and flags a downgrade fix", () => {
    const { rows, failing } = buildReport(DEV_CHAIN, LOCK);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pkg: "esbuild",
      installed: "0.18.20",
      severity: "moderate",
      range: "<=0.24.2",
      via: ["drizzle-kit"],
      scope: "dev",
    });
    expect(rows[0]!.fix).toContain("downgrade (drizzle-kit 0.31.11 → 0.18.1)");
    expect(failing).toEqual([]);
  });

  it("fails on high or critical in production dependencies", () => {
    expect(buildReport(prodDirect("high"), LOCK).failing).toHaveLength(1);
    expect(buildReport(prodDirect("critical"), LOCK).failing).toHaveLength(1);
    expect(buildReport(prodDirect("moderate"), LOCK).failing).toHaveLength(0);
  });

  it("never fails on dev-only findings, even critical ones", () => {
    const audit = structuredClone(DEV_CHAIN);
    audit.vulnerabilities!.esbuild!.via = [advisory("dev-server", "critical")];
    const { rows, failing } = buildReport(audit, LOCK);
    expect(rows[0]!.severity).toBe("critical");
    expect(failing).toEqual([]);
  });

  it("suggests an exact install, an audit fix, or an override", () => {
    expect(buildReport(prodDirect("high"), LOCK).rows[0]!.fix).toBe("`npm install postgres@3.4.10 --save-exact`");
    expect(buildReport(prodDirect("high", true), LOCK).rows[0]!.fix).toContain("npm audit fix");
    expect(buildReport(prodDirect("high", false), LOCK).rows[0]!.fix).toContain("overrides");
    const major = buildReport(prodDirect("high", { name: "postgres", version: "4.0.0", isSemVerMajor: true }), LOCK);
    expect(major.rows[0]!.fix).toBe("`npm install postgres@4.0.0 --save-exact` (major)");
  });

  it("sorts production before dev, then by severity", () => {
    const audit: AuditJson = { vulnerabilities: { ...DEV_CHAIN.vulnerabilities, ...prodDirect("low").vulnerabilities } };
    audit.vulnerabilities!.esbuild!.via = [advisory("dev-server", "critical")];
    expect(buildReport(audit, LOCK).rows.map((r) => r.pkg)).toEqual(["postgres", "esbuild"]);
  });
});

describe("markdown", () => {
  const SHA = "0123456789abcdef";

  it("the PR comment carries the marker, counts, verdict and table", () => {
    const body = prComment(buildReport(prodDirect("high"), LOCK), SHA);
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("1 high (1 in production dependencies, 0 dev-only)");
    expect(body).toContain("this check fails");
    expect(body).toContain("`0123456`");
    expect(body).toContain("| postgres | 3.4.9 | high |");
  });

  it("a clean PR comment says resolved", () => {
    const body = prComment(buildReport({ vulnerabilities: {} }, LOCK), SHA);
    expect(body).toContain(MARKER);
    expect(body).toContain("Resolved at `0123456`");
  });

  it("caps the comment table and points to the step summary", () => {
    const vulnerabilities: AuditJson["vulnerabilities"] = {};
    for (let i = 0; i < MAX_ROWS + 3; i++) {
      vulnerabilities[`p${i}`] = { ...prodDirect("low").vulnerabilities!.postgres!, name: `p${i}`, nodes: [`node_modules/p${i}`] };
    }
    const report = buildReport({ vulnerabilities }, LOCK);
    expect(prComment(report, SHA)).toContain("…and 3 more");
    expect(stepSummary(report)).not.toContain("more");
  });

  it("escapes pipes so a title can't break the table", () => {
    const audit = prodDirect("low");
    audit.vulnerabilities!.postgres!.via = [{ ...advisory("a", "low"), title: "a | b" }];
    expect(prComment(buildReport(audit, LOCK), SHA)).toContain("a \\| b");
  });

  it("the weekly issue body carries the marker and the table", () => {
    const body = issueBody(buildReport(DEV_CHAIN, LOCK), SHA);
    expect(body).toContain(MARKER);
    expect(body).toContain("weekly audit of `main`");
    expect(body).toContain("| esbuild |");
  });
});

describe("updatesMainIssue", () => {
  it("only a run on main updates the weekly issue", () => {
    expect(updatesMainIssue("refs/heads/main")).toBe(true);
    expect(updatesMainIssue("refs/heads/fix/x")).toBe(false);
    expect(updatesMainIssue(undefined)).toBe(false);
  });
});
