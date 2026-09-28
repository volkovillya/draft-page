// CI entry point (.github/workflows/deps-audit.yml): runs `npm audit`, writes the step summary,
// then keeps one sticky PR comment (pull requests) or one issue (weekly run on main) up to date.
// Exit 1 when production dependencies have high/critical findings, or when the audit is unavailable.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import {
  AuditUnavailable,
  buildReport,
  ISSUE_TITLE,
  issueBody,
  MARKER,
  parseAudit,
  prComment,
  updatesMainIssue,
  type Report,
  stepSummary,
} from "./report.ts";
import { all, BOT, github, ours } from "../lib/github.ts";

const env = process.env;
const repo = env.GITHUB_REPOSITORY ?? "";
const sha = env.GITHUB_SHA ?? "";

function summary(text: string) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  else console.log(text);
}

const isOurs = ours(MARKER);

async function updatePullRequest(number: number, report: Report) {
  const existing = (await all(`/repos/${repo}/issues/${number}/comments`)).find(isOurs);
  // Stay quiet on a clean PR that never had findings.
  if (!existing && report.rows.length === 0) return;
  const body = prComment(report, env.PR_HEAD_SHA || sha);
  if (existing) await github("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
  else await github("POST", `/repos/${repo}/issues/${number}/comments`, { body });
}

async function updateIssue(report: Report) {
  const issues = await all(`/repos/${repo}/issues?state=all&creator=${encodeURIComponent(BOT)}`);
  const existing = issues.find((i) => !i.pull_request && isOurs(i));
  if (report.rows.length > 0) {
    const body = issueBody(report, sha);
    if (existing) await github("PATCH", `/repos/${repo}/issues/${existing.number}`, { body, state: "open" });
    else await github("POST", `/repos/${repo}/issues`, { title: ISSUE_TITLE, body });
  } else if (existing?.state === "open") {
    await github("POST", `/repos/${repo}/issues/${existing.number}/comments`, {
      body: `✅ Resolved at \`${sha.slice(0, 7)}\`: the audit is clean.`,
    });
    await github("PATCH", `/repos/${repo}/issues/${existing.number}`, { state: "closed" });
  }
}

async function main(): Promise<number> {
  let report: Report;
  try {
    // npm audit exits non-zero whenever it finds something, so read stdout either way.
    let stdout: string;
    try {
      stdout = execFileSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    } catch (error) {
      stdout = String((error as { stdout?: unknown }).stdout ?? "");
    }
    report = buildReport(parseAudit(stdout), JSON.parse(readFileSync("package-lock.json", "utf8")));
  } catch (error) {
    if (!(error instanceof AuditUnavailable)) throw error;
    summary(`### Dependency audit\n⚠️ Audit unavailable: ${error.message}. Re-run the job.\n`);
    return 1;
  }

  summary(stepSummary(report));
  if (env.GITHUB_TOKEN && repo) {
    try {
      if (env.PR_NUMBER) await updatePullRequest(Number(env.PR_NUMBER), report);
      else if (updatesMainIssue(env.GITHUB_REF)) await updateIssue(report);
    } catch (error) {
      // The verdict still stands when commenting fails (e.g. a read-only token).
      console.warn(`::warning::Could not update the comment or issue: ${(error as Error).message}`);
    }
  }
  return report.failing.length > 0 ? 1 : 0;
}

process.exitCode = await main();
