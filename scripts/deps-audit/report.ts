// Turns `npm audit --json` output plus package-lock.json into rows, markdown and a verdict.
// Pure: no I/O, so it's unit-tested with fixtures (tests/deps-audit).

export const MARKER = "<!-- draftpage-deps-audit -->";
export const MAX_ROWS = 20;

const SEVERITIES = ["critical", "high", "moderate", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

type Advisory = { title: string; url: string; severity: Severity; range: string };
type Fix = { name: string; version: string; isSemVerMajor: boolean } | boolean;
type Vulnerability = {
  name: string;
  severity: Severity;
  isDirect: boolean;
  via: (string | Advisory)[];
  effects: string[];
  range: string;
  nodes: string[];
  fixAvailable: Fix;
};
export type AuditJson = { vulnerabilities?: Record<string, Vulnerability>; error?: unknown };
export type Lockfile = { packages?: Record<string, { version?: string; dev?: boolean; devOptional?: boolean }> };

export type Row = {
  pkg: string;
  installed: string;
  severity: Severity;
  title: string;
  url: string;
  range: string;
  /** The direct dependencies that pull it in (itself when it is one). */
  via: string[];
  scope: "prod" | "dev";
  fix: string;
};

export type Report = { rows: Row[]; failing: Row[] };

/** Thrown when the audit didn't produce a usable report (registry down, bad output). */
export class AuditUnavailable extends Error {}

export function parseAudit(stdout: string): AuditJson {
  let audit: AuditJson;
  try {
    audit = JSON.parse(stdout) as AuditJson;
  } catch {
    throw new AuditUnavailable("npm audit did not return JSON");
  }
  if (audit.error || typeof audit.vulnerabilities !== "object") {
    throw new AuditUnavailable("npm audit returned an error instead of a report");
  }
  return audit;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function directRoots(name: string, vulns: Record<string, Vulnerability>, seen = new Set<string>()): string[] {
  const v = vulns[name];
  if (!v || seen.has(name)) return [];
  seen.add(name);
  const up = v.effects.flatMap((e) => directRoots(e, vulns, seen));
  return v.isDirect ? [name, ...up] : up;
}

function fixText(v: Vulnerability, lock: Lockfile, scope: Row["scope"]): string {
  const fix = v.fixAvailable;
  if (fix === true) return "`npm audit fix` (updates the lockfile only)";
  if (fix === false) return "no fixed version in range: add an `overrides` entry, or wait for upstream";
  const current = lock.packages?.[`node_modules/${fix.name}`]?.version;
  if (current && compareVersions(fix.version, current) < 0) {
    return `npm only offers a downgrade (${fix.name} ${current} → ${fix.version}): prefer an \`overrides\` entry`;
  }
  const dev = scope === "dev" ? " --save-dev" : "";
  return `\`npm install ${fix.name}@${fix.version} --save-exact${dev}\`${fix.isSemVerMajor ? " (major)" : ""}`;
}

export function buildReport(audit: AuditJson, lock: Lockfile): Report {
  const vulns = audit.vulnerabilities ?? {};
  const rows: Row[] = [];
  for (const v of Object.values(vulns)) {
    const node = lock.packages?.[v.nodes[0] ?? ""];
    const scope: Row["scope"] = node?.dev || node?.devOptional ? "dev" : "prod";
    const via = [...new Set(directRoots(v.name, vulns))];
    for (const a of v.via) {
      if (typeof a === "string") continue; // a package that is only vulnerable through another one
      rows.push({
        pkg: v.name,
        installed: node?.version ?? "?",
        severity: a.severity,
        title: a.title,
        url: a.url,
        range: a.range,
        via,
        scope,
        fix: fixText(v, lock, scope),
      });
    }
  }
  rows.sort(
    (x, y) =>
      (x.scope === y.scope ? 0 : x.scope === "prod" ? -1 : 1) ||
      SEVERITIES.indexOf(x.severity) - SEVERITIES.indexOf(y.severity) ||
      x.pkg.localeCompare(y.pkg),
  );
  const failing = rows.filter((r) => r.scope === "prod" && (r.severity === "critical" || r.severity === "high"));
  return { rows, failing };
}

function counts(rows: Row[]): string {
  const parts = SEVERITIES.flatMap((s) => {
    const n = rows.filter((r) => r.severity === s).length;
    return n ? [`${n} ${s}`] : [];
  });
  const dev = rows.filter((r) => r.scope === "dev").length;
  return `${parts.join(", ")} (${rows.length - dev} in production dependencies, ${dev} dev-only)`;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function table(rows: Row[], max = Infinity): string {
  const shown = rows.slice(0, max);
  const lines = [
    "| Package | Installed | Severity | Advisory | Vulnerable | Pulled in by | Scope | Fix |",
    "|---|---|---|---|---|---|---|---|",
    ...shown.map(
      (r) =>
        `| ${cell(r.pkg)} | ${cell(r.installed)} | ${r.severity} | [${cell(r.title)}](${r.url}) | ${cell(r.range)} | ` +
        `${r.via.length ? cell(r.via.join(", ")) : "—"} | ${r.scope} | ${cell(r.fix)} |`,
    ),
  ];
  if (rows.length > shown.length) lines.push("", `…and ${rows.length - shown.length} more (see the run's step summary).`);
  return lines.join("\n");
}

function verdictLine(report: Report): string {
  return report.failing.length
    ? `**❌ ${report.failing.length} high or critical in production dependencies: this check fails until they're fixed.**`
    : "The check passes: nothing high or critical in production dependencies.";
}

export function prComment(report: Report, sha: string): string {
  if (report.rows.length === 0) {
    return `${MARKER}\n### Dependency audit\n✅ Resolved at \`${sha.slice(0, 7)}\`: no known vulnerabilities.\n`;
  }
  return [
    MARKER,
    "### Dependency audit",
    `Found ${counts(report.rows)} at \`${sha.slice(0, 7)}\`.`,
    verdictLine(report),
    "",
    table(report.rows, MAX_ROWS),
    "",
    "<sub>From `npm audit` (GitHub Advisory Database). Dev-only and moderate/low findings are shown but never fail the check.</sub>",
    "",
  ].join("\n");
}

export const ISSUE_TITLE = "Dependency vulnerabilities on main";

/** The issue tracks main: runs on other branches (e.g. a manual run) only write the step summary. */
export const updatesMainIssue = (ref: string | undefined) => ref === "refs/heads/main";

export function issueBody(report: Report, sha: string): string {
  return [
    MARKER,
    `The weekly audit of \`main\` at \`${sha.slice(0, 7)}\` found ${counts(report.rows)}.`,
    verdictLine(report),
    "",
    table(report.rows, MAX_ROWS),
    "",
    "This issue is updated by the weekly run and closed when the audit is clean.",
    "",
  ].join("\n");
}

export function stepSummary(report: Report): string {
  if (report.rows.length === 0) return "### Dependency audit\n✅ No known vulnerabilities.\n";
  return `### Dependency audit\nFound ${counts(report.rows)}.\n${verdictLine(report)}\n\n${table(report.rows)}\n`;
}
