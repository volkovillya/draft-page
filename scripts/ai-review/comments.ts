// Comment texts: the inline comments, and one summary comment with usage, cost and a running
// total for the PR (kept in a hidden state line the next run reads back).
import type { Finding } from "./review.ts";

export const SUMMARY_MARKER = "<!-- draftpage-ai-review -->";
export const INLINE_MARKER = "<!-- draftpage-ai-review-inline -->";
const STATE_RE = /<!-- draftpage-ai-review-state (\{.*?\}) -->/;
export const MAX_RUNS = 10;

export type Totals = { runs: number; inputTokens: number; outputTokens: number; costUsd: number | null };
export const NO_TOTALS: Totals = { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

export function readTotals(body: string | undefined): Totals {
  const m = body ? STATE_RE.exec(body) : null;
  if (!m?.[1]) return NO_TOTALS;
  try {
    const t = JSON.parse(m[1]) as Partial<Totals>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    return {
      runs: n(t.runs),
      inputTokens: n(t.inputTokens),
      outputTokens: n(t.outputTokens),
      costUsd: t.costUsd === null ? null : n(t.costUsd),
    };
  } catch {
    return NO_TOTALS;
  }
}

export type Usage = { inputTokens: number; outputTokens: number; costUsd: number | null };

export function addUsage(totals: Totals, usage: Usage): Totals {
  return {
    runs: totals.runs + 1,
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    costUsd: totals.costUsd === null || usage.costUsd === null ? null : totals.costUsd + usage.costUsd,
  };
}

/**
 * Model text is untrusted: no HTML comments (it could forge our markers or the state line),
 * no raw HTML, and no @mentions that would notify people.
 */
export function clean(text: string): string {
  return text
    .replace(/<!--|-->/g, "")
    .replace(/</g, "&lt;")
    .replace(/@(?=[\w-])/g, "@\u200b")
    .trim();
}

const ICON: Record<Finding["severity"], string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪" };
const shortModel = (modelId: string) => modelId.replace(/^([a-z]+\.)?(openai|anthropic|meta|amazon)\./, "");
const money = (usd: number | null) => (usd === null ? "price unknown" : `$${usd.toFixed(4)}`);
const num = (n: number) => n.toLocaleString("en-US");

export function inlineComment(f: Finding, modelId: string): string {
  return [
    INLINE_MARKER,
    `${ICON[f.severity]} **${f.severity}** · \`${clean(f.rule)}\` · **${clean(f.title)}**`,
    "",
    clean(f.body),
    ...(f.fix ? ["", "```suggestion", f.fix.code, "```"] : []),
    "",
    `<sub>AI review (${shortModel(modelId)}), advisory only.${f.fix ? " Check the suggestion before committing it." : ""}</sub>`,
  ].join("\n");
}

export type SummaryInput = {
  status: "reviewed" | "unavailable" | "capped";
  modelId: string;
  sha: string;
  reason?: string;
  modelSummary?: string;
  inline?: Finding[];
  other?: Finding[];
  omitted?: string[];
  usage: Usage;
  totals: Totals;
};

function usageTable(s: SummaryInput): string {
  const t = s.totals;
  return [
    `**Usage:** \`${s.modelId}\``,
    "",
    "| | Runs | Input tokens | Output tokens | Cost |",
    "|---|---|---|---|---|",
    `| This run | 1 | ${num(s.usage.inputTokens)} | ${num(s.usage.outputTokens)} | ${money(s.usage.costUsd)} |`,
    `| This PR | ${t.runs} | ${num(t.inputTokens)} | ${num(t.outputTokens)} | ${money(t.costUsd)} |`,
    "",
    "<sub>Cost from list prices; output tokens include the model's reasoning. The AWS bill is the source of truth.</sub>",
  ].join("\n");
}

export function summaryComment(s: SummaryInput): string {
  const lines = [SUMMARY_MARKER, "### AI review", ""];
  const sha = `\`${s.sha.slice(0, 7)}\``;
  if (s.status === "unavailable") {
    lines.push(`⚠️ AI review unavailable at ${sha}: ${s.reason ?? "unknown reason"}. Checks are unaffected.`);
  } else if (s.status === "capped") {
    lines.push(`⏸️ This PR already had ${MAX_RUNS} AI reviews, so ${sha} wasn't reviewed (cost cap).`);
  } else {
    const inline = s.inline ?? [];
    const other = s.other ?? [];
    lines.push(
      inline.length + other.length === 0
        ? `✅ No issues found at ${sha}.`
        : `Reviewed ${sha}: ${inline.length} inline comment${inline.length === 1 ? "" : "s"}` +
            (other.length ? `, ${other.length} more below` : "") +
            ".",
    );
    if (s.modelSummary) lines.push("", `> ${clean(s.modelSummary).replace(/\n+/g, " ")}`);
    if (other.length) {
      lines.push("", "**Also noted:**");
      for (const f of other) {
        lines.push(`- ${ICON[f.severity]} \`${clean(f.rule)}\` ${clean(f.title)} (\`${clean(f.file)}\`): ${clean(f.body)}`);
      }
    }
    if (s.omitted?.length) lines.push("", `<sub>Not reviewed (over the size budget): ${s.omitted.join(", ")}</sub>`);
  }
  lines.push(
    "",
    usageTable(s),
    "",
    "<sub>Advisory only: it never blocks a merge. Add the `ai-review` label to run it again.</sub>",
    `<!-- draftpage-ai-review-state ${JSON.stringify(s.totals)} -->`,
  );
  return lines.join("\n");
}
