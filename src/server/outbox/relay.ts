/**
 * Transactional outbox relay (§23), sized for a tiny app: a timer inside the web server.
 * Every few seconds (and right after an "@Claude" comment) it publishes due outbox rows and
 * stamps them dispatched. A failed publish is retried later with exponential backoff and
 * jitter, so a queue outage never loses a job and never blocks the web app.
 */
import { and, asc, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import { outboxEvents } from "../db/tables";
import { failStaleJobs } from "../core/ai-worker";

export type OutboxMessage = { id: string; topic: string; payload: unknown };
export type Publisher = (message: OutboxMessage) => Promise<void>;

const BATCH = 10;
const MAX_ATTEMPTS = 20;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 10 * 60_000;
/** Jobs still unfinished this long after the comment are failed (a worker died silently). */
export const STALE_JOB_MINUTES = 30;

/** 5 s, 10 s, 20 s … capped at 10 min, each ±20% so retries from many rows spread out. */
export function retryDelayMs(attempts: number, random = Math.random): number {
  const base = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), MAX_DELAY_MS);
  return Math.round(base * (0.8 + 0.4 * random()));
}

/**
 * Publishes up to BATCH due rows. SKIP LOCKED lets two app tasks (e.g. during a deploy) run
 * this at once without both sending the same row. At-least-once: a crash after the publish but
 * before the stamp sends that row again later, which the worker tolerates.
 */
export async function dispatchDue(db: Db, publish: Publisher): Promise<{ sent: number; failed: number }> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(outboxEvents)
      .where(
        and(
          isNull(outboxEvents.dispatchedAt),
          lte(outboxEvents.availableAt, sql`now()`),
          sql`${outboxEvents.attempts} < ${MAX_ATTEMPTS}`,
        ),
      )
      .orderBy(asc(outboxEvents.availableAt))
      .limit(BATCH)
      .for("update", { skipLocked: true });

    let sent = 0;
    let failed = 0;
    for (const row of due) {
      try {
        await publish({ id: row.id, topic: row.topic, payload: row.payload });
        await tx
          .update(outboxEvents)
          .set({ dispatchedAt: sql`now()`, attempts: row.attempts + 1, lastError: null })
          .where(sql`${outboxEvents.id} = ${row.id}`);
        sent += 1;
      } catch (error) {
        const attempts = row.attempts + 1;
        await tx
          .update(outboxEvents)
          .set({
            attempts,
            lastError: String((error as Error)?.name ?? "Error").slice(0, 200),
            availableAt: sql`now() + make_interval(secs => ${retryDelayMs(attempts) / 1000})`,
          })
          .where(sql`${outboxEvents.id} = ${row.id}`);
        failed += 1;
      }
    }
    return { sent, failed };
  });
}

type RelayState = { timer?: NodeJS.Timeout; running: boolean; again: boolean; kick: () => void; lastSweep: number };
const state = globalThis as typeof globalThis & { __draftpageRelay?: RelayState };

/** Starts the relay loop once per server process (safe across dev hot reloads). */
export function startRelay(options: { db: () => Db; publish: Publisher; intervalMs?: number }): void {
  if (state.__draftpageRelay) return;
  const relay: RelayState = { running: false, again: false, lastSweep: 0, kick: () => {} };
  const tick = async () => {
    if (relay.running) {
      relay.again = true; // a kick arrived mid-run: go once more right after
      return;
    }
    relay.running = true;
    try {
      do {
        relay.again = false;
        const db = options.db();
        const { sent, failed } = await dispatchDue(db, options.publish);
        if (sent || failed) log({ msg: "outbox dispatched", sent, failed });
        if (Date.now() - relay.lastSweep > 5 * 60_000) {
          relay.lastSweep = Date.now();
          const stale = await failStaleJobs(db, STALE_JOB_MINUTES);
          if (stale) log({ msg: "stale AI jobs failed", count: stale });
        }
      } while (relay.again);
    } catch (error) {
      log({ level: "error", msg: "outbox relay error", err: String((error as Error)?.name ?? error) });
    } finally {
      relay.running = false;
    }
  };
  relay.kick = () => void tick();
  relay.timer = setInterval(relay.kick, options.intervalMs ?? 5_000);
  relay.timer.unref();
  state.__draftpageRelay = relay;
}

/** Publishes right away instead of waiting for the next tick (after an "@Claude" comment). */
export function kickRelay(): void {
  state.__draftpageRelay?.kick();
}

function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ level: "info", ...fields }));
}
