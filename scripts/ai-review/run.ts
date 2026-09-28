// CI entry point (.github/workflows/ai-review.yml), bundled with esbuild so it can share the
// price table in src/ai. One Bedrock call per run; the script, never the model, posts comments.
// Advisory: it always exits 0 unless the script itself is broken.
//
// Local dry run (no GitHub, no AWS): prints the prompt and the worst-case cost.
//   git diff main... > /tmp/pr.diff && npm run ai-review -- --dry-run --diff-file /tmp/pr.diff
import { appendFileSync, readFileSync } from "node:fs";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { estimateCostUsd } from "../../src/ai/bedrock-editor.ts";
import { all, github, GitHubError, ours, pullRequestDiff } from "../lib/github.ts";
import {
  addUsage,
  INLINE_MARKER,
  inlineComment,
  MAX_RUNS,
  readTotals,
  SUMMARY_MARKER,
  type SummaryInput,
  summaryComment,
  type Usage,
} from "./comments.ts";
import { docsOnly, parseUnifiedDiff, planReview, selectFiles } from "./diff.ts";
import { callReviewModel, MAX_OUTPUT_TOKENS, ModelUnavailable } from "./model.ts";
import { buildPrompt, type Finding, parseAnswer, placeFindings } from "./review.ts";

/** About 30k tokens of diff; with the rules and instructions the input stays under ~40k tokens. */
export const MAX_DIFF_BYTES = 100_000;
const RULES_FILE = ".github/ai-review/rules.txt";
const LABEL = "ai-review";

const env = process.env;
const modelId = env.AI_REVIEW_MODEL_ID || "openai.gpt-oss-120b-1:0";
const region = env.AI_REVIEW_REGION || env.AWS_REGION || "eu-north-1";

function stepSummary(text: string) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  else console.log(text);
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function dryRun(diffFile: string) {
  const files = parseUnifiedDiff(readFileSync(diffFile, "utf8"));
  const { included, omitted } = selectFiles(files, MAX_DIFF_BYTES);
  const prompt = buildPrompt({ title: "(dry run)", body: "", rules: readFileSync(RULES_FILE, "utf8"), files: included, omitted });
  const inputTokens = Math.ceil(Buffer.byteLength(prompt.system + prompt.user) / 3);
  console.log(`${prompt.system}\n\n----- user -----\n${prompt.user}\n`);
  console.log(`Files reviewed: ${included.length}, omitted: ${omitted.length}, docs only: ${docsOnly(files.map((f) => f.path))}`);
  console.log(
    `Estimate: ~${inputTokens} input tokens, up to ${MAX_OUTPUT_TOKENS} output → at most ` +
      `$${estimateCostUsd(modelId, inputTokens, MAX_OUTPUT_TOKENS)?.toFixed(4) ?? "?"} on ${modelId}`,
  );
}

const priced = (inputTokens: number, outputTokens: number): Usage => ({
  inputTokens,
  outputTokens,
  costUsd: estimateCostUsd(modelId, inputTokens, outputTokens),
});

type Pull = { title: string; body: string | null; draft: boolean; head: { sha: string } };

async function review() {
  const repo = env.GITHUB_REPOSITORY ?? "";
  const number = Number(env.PR_NUMBER);
  const pull = (await github("GET", `/repos/${repo}/pulls/${number}`)) as Pull;
  const sha = pull.head.sha;
  const files = parseUnifiedDiff(await pullRequestDiff(repo, number));

  const plan = planReview(files, MAX_DIFF_BYTES);
  if (plan.kind === "skip") {
    stepSummary("### AI review\nSkipped: only docs, lockfiles or other files it doesn't review changed.");
    return;
  }

  const comments = await all(`/repos/${repo}/issues/${number}/comments`);
  const previous = comments.find(ours(SUMMARY_MARKER));
  const before = readTotals(previous?.body);

  const post = async (s: Omit<SummaryInput, "modelId" | "sha">) => {
    const body = summaryComment({ ...s, modelId, sha });
    if (previous) await github("PATCH", `/repos/${repo}/issues/comments/${previous.id}`, { body });
    else await github("POST", `/repos/${repo}/issues/${number}/comments`, { body });
    stepSummary(body);
  };
  const zero: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  if (before.runs >= MAX_RUNS) return post({ status: "capped", usage: zero, totals: before });
  if (plan.kind === "too-large") {
    const reason = `every changed file is over the review's size budget (${plan.omitted.join(", ")})`;
    return post({ status: "unavailable", reason, usage: zero, totals: before });
  }
  if (env.AWS_READY !== "true") {
    return post({ status: "unavailable", reason: "the AWS login for the reviewer isn't set up or failed", usage: zero, totals: before });
  }

  const { included, omitted } = plan;
  const prompt = buildPrompt({
    title: pull.title,
    body: pull.body ?? "",
    rules: readFileSync(RULES_FILE, "utf8"),
    files: included,
    omitted,
  });

  const client = new BedrockRuntimeClient({ region, maxAttempts: 1 });
  let usage: Usage;
  let placed: { inline: Finding[]; other: Finding[] };
  let modelSummary: string;
  try {
    const reply = await callReviewModel(client, modelId, prompt);
    usage = priced(reply.inputTokens, reply.outputTokens);
    const answer = parseAnswer(reply.raw);
    if (!answer) {
      return post({ status: "unavailable", reason: "the model's answer couldn't be read", usage, totals: addUsage(before, usage) });
    }
    placed = placeFindings(answer, included);
    modelSummary = answer.summary;
  } catch (error) {
    if (!(error instanceof ModelUnavailable)) throw error;
    usage = priced(error.inputTokens, error.outputTokens);
    return post({ status: "unavailable", reason: error.message, usage, totals: addUsage(before, usage) });
  }
  const totals = addUsage(before, usage);

  // Replace this bot's earlier inline comments, so only the latest review's comments remain.
  for (const c of await all(`/repos/${repo}/pulls/${number}/comments`)) {
    if (ours(INLINE_MARKER)(c)) await github("DELETE", `/repos/${repo}/pulls/comments/${c.id}`);
  }
  if (placed.inline.length) {
    try {
      await github("POST", `/repos/${repo}/pulls/${number}/reviews`, {
        commit_id: sha,
        event: "COMMENT",
        body: `AI review: ${placed.inline.length} comment${placed.inline.length === 1 ? "" : "s"} (advisory). Summary, usage and cost are in the PR comment below.`,
        comments: placed.inline.map((f) => ({
          path: f.file,
          line: f.line,
          side: "RIGHT",
          // A multi-line suggestion spans its whole range.
          ...(f.fix && f.fix.startLine < f.fix.endLine ? { start_line: f.fix.startLine, start_side: "RIGHT" } : {}),
          body: inlineComment(f, modelId),
        })),
      });
    } catch (error) {
      // GitHub rejects the whole review if one line isn't in the diff: keep the findings in the summary.
      if (!(error instanceof GitHubError) || error.status !== 422) throw error;
      placed = { inline: [], other: [...placed.inline, ...placed.other] };
    }
  }
  await post({ status: "reviewed", modelSummary, ...placed, omitted, usage, totals });
}

async function main() {
  const diffFile = argValue("--diff-file");
  if (process.argv.includes("--dry-run")) {
    if (!diffFile) throw new Error("--dry-run needs --diff-file <path>");
    return dryRun(diffFile);
  }
  try {
    await review();
  } catch (error) {
    // Advisory: a broken review must not turn the pull request red. The reason goes to the run page.
    console.log(`::warning::AI review failed: ${(error as Error).message}`);
    stepSummary(`### AI review\n⚠️ Failed: ${(error as Error).message}`);
  }
  // Let the label be added again to ask for another run.
  if (env.LABEL_ADDED === LABEL) {
    await github("DELETE", `/repos/${env.GITHUB_REPOSITORY}/issues/${env.PR_NUMBER}/labels/${LABEL}`).catch(() => {});
  }
}

await main();
