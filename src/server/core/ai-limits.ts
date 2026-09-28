import { eq, gt, gte, sql, type SQL } from "drizzle-orm";
import { maxAiPageBytes, worstCaseEditCostUsd } from "../../ai";
import type { Tx } from "../db/connection";
import { aiRequests } from "../db/tables";
import { tooMany } from "./failures";

/**
 * Caps on "@Claude" edits: how many may start in any rolling 24 hours (per person and for
 * everyone together), and what they may cost in a calendar month (UTC, like the AWS bill).
 * `reserveUsd` is the most one attempt can cost with the configured model; it's held against
 * the monthly budget until the real cost is known. `maxPageBytes` is the largest page the
 * model can edit (its reply limit decides).
 */
export type AiLimits = {
  perMember: number;
  total: number;
  monthlyBudgetUsd: number;
  reserveUsd: number;
  maxPageBytes: number;
};

export const DEFAULT_AI_LIMITS = { perMember: 10, total: 30, monthlyBudgetUsd: 5 };

const WINDOW_HOURS = 24;
const REMOVE_MENTION = 'To post it as a normal comment, remove "@Claude".';

/** Reads the limits; 0 turns AI edits off. A malformed value fails loudly instead of guessing. */
export function aiLimitsFromEnv(env: Record<string, string | undefined> = process.env): AiLimits {
  return {
    perMember: numberFrom(env, "DRAFTPAGE_AI_LIMIT_PER_MEMBER", DEFAULT_AI_LIMITS.perMember, /^\d{1,6}$/),
    total: numberFrom(env, "DRAFTPAGE_AI_LIMIT_TOTAL", DEFAULT_AI_LIMITS.total, /^\d{1,6}$/),
    monthlyBudgetUsd: numberFrom(
      env,
      "DRAFTPAGE_AI_MONTHLY_BUDGET_USD",
      DEFAULT_AI_LIMITS.monthlyBudgetUsd,
      /^\d{1,5}(\.\d{1,2})?$/,
    ),
    reserveUsd: worstCaseEditCostUsd(env),
    maxPageBytes: maxAiPageBytes(env),
  };
}

function numberFrom(env: Record<string, string | undefined>, name: string, fallback: number, shape: RegExp): number {
  const value = env[name]?.trim();
  if (value === undefined || value === "") return fallback;
  if (!shape.test(value)) throw new Error(`${name} must be a number of 0 or more (got "${value}")`);
  return Number(value);
}

/** What one request has cost so far: the last attempt's real cost (or its hold) plus a hold per earlier attempt. */
const requestSpend = sql`coalesce(${aiRequests.costUsd}, ${aiRequests.reservedUsd}) + ${aiRequests.reservedUsd} * (${aiRequests.attempts} - 1)`;

/**
 * Counts one "@Claude" request against the limits, or refuses it with a 429 that says when
 * to try again. Must run inside the transaction that creates the job, so a refusal rolls
 * back the thread too and the reviewer keeps their text.
 */
export async function takeAiAllowance(tx: Tx, memberId: string, jobId: string, limits: AiLimits): Promise<void> {
  // One lock for every check: two requests at the same moment can't both take the last slot.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('draftpage:ai-allowance'))`);

  if (limits.perMember === 0 || limits.total === 0 || limits.monthlyBudgetUsd === 0) {
    throw tooMany(`AI edits are turned off right now. ${REMOVE_MENTION}`);
  }

  const mine = sql`${aiRequests.memberId} = ${memberId}`;
  const freesIn = (filter: SQL | null) =>
    sql<number | null>`extract(epoch from min(${aiRequests.createdAt})${filter ? sql` filter (where ${filter})` : sql``}
      + make_interval(hours => ${WINDOW_HOURS}) - now())::int`;
  const [usage] = await tx
    .select({
      total: sql<number>`count(*)::int`,
      mine: sql<number>`(count(*) filter (where ${mine}))::int`,
      totalFreesIn: freesIn(null),
      mineFreesIn: freesIn(mine),
    })
    .from(aiRequests)
    .where(gt(aiRequests.createdAt, sql`now() - make_interval(hours => ${WINDOW_HOURS})`));

  if (usage!.mine >= limits.perMember) {
    throw tooMany(
      `You've used your ${limits.perMember} AI edits for the last 24 hours.${tryAgain(usage!.mineFreesIn)} ${REMOVE_MENTION}`,
    );
  }
  if (usage!.total >= limits.total) {
    throw tooMany(
      `Everyone together has used the ${limits.total} AI edits for the last 24 hours.${tryAgain(usage!.totalFreesIn)} ${REMOVE_MENTION}`,
    );
  }

  // Refuse when this edit's worst case could take the month past the budget, so it's never exceeded.
  if ((await monthSpentUsd(tx)) + limits.reserveUsd > limits.monthlyBudgetUsd) {
    throw tooMany(
      `This month's AI budget ($${limits.monthlyBudgetUsd.toFixed(2)}) is used up. It resets on ${nextMonthStart()}. ${REMOVE_MENTION}`,
    );
  }

  await tx.insert(aiRequests).values({ memberId, jobId, reservedUsd: limits.reserveUsd.toFixed(6) });
}

export type AttemptCharge = "ok" | "no_request" | "over_budget";

/**
 * Charges one model attempt, in the claim's transaction. The first attempt was held when the
 * request was accepted; a retry may be billed again, so it holds another worst case, and only
 * if that still fits this month's budget. A job with no ai_requests row (it bypassed the
 * limits) is refused.
 */
export async function chargeAiAttempt(
  tx: Tx,
  jobId: string,
  attempt: number,
  limits: AiLimits,
): Promise<AttemptCharge> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('draftpage:ai-allowance'))`);
  const [request] = await tx
    .select({ reservedUsd: aiRequests.reservedUsd })
    .from(aiRequests)
    .where(eq(aiRequests.jobId, jobId));
  if (!request) return "no_request";
  if (attempt > 1 && (await monthSpentUsd(tx)) + Number(request.reservedUsd) > limits.monthlyBudgetUsd) {
    return "over_budget";
  }
  await tx.update(aiRequests).set({ attempts: attempt }).where(eq(aiRequests.jobId, jobId));
  return "ok";
}

async function monthSpentUsd(tx: Tx): Promise<number> {
  const [month] = await tx
    .select({ spent: sql<string>`coalesce(sum(${requestSpend}), 0)` })
    .from(aiRequests)
    .where(gte(aiRequests.createdAt, sql`date_trunc('month', now(), 'UTC')`));
  return Number(month!.spent);
}

/** The last attempt's real cost replaces its hold. Unknown costs (null) keep the hold; "0" releases it (no model call). */
export async function settleAiCost(tx: Tx, jobId: string, costUsd: string | null): Promise<void> {
  if (costUsd === null) return;
  await tx.update(aiRequests).set({ costUsd }).where(eq(aiRequests.jobId, jobId));
}

function tryAgain(seconds: number | null): string {
  if (seconds === null) return "";
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return ` Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  const hours = Math.round(minutes / 60);
  return ` Try again in about ${hours} hour${hours === 1 ? "" : "s"}.`;
}

function nextMonthStart(now = new Date()): string {
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return first.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}
