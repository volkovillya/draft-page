import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openThread } from "@/server/core/threads";
import { outboxEvents } from "@/server/db/tables";
import { dispatchDue, retryDelayMs } from "@/server/outbox/relay";
import { closeTestDb, makeMember, makePage, reset, testDb } from "../helpers/db";

const db = testDb();

beforeEach(reset);
afterAll(closeTestDb);

async function requestEdits(count: number) {
  const owner = await makeMember();
  const page = await makePage(owner);
  for (let i = 0; i < count; i += 1) {
    await openThread(db, owner, { versionId: page.versionId, posX: 0.1, posY: 0.1, text: `@Claude change ${i}` });
  }
}
const rows = () => db.select().from(outboxEvents).orderBy(outboxEvents.createdAt);

describe("dispatchDue", () => {
  it("publishes each due event with its job id and stamps it dispatched", async () => {
    await requestEdits(2);
    const publish = vi.fn().mockResolvedValue(undefined);
    expect(await dispatchDue(db, publish)).toEqual({ sent: 2, failed: 0 });
    const [a, b] = await rows();
    expect(publish).toHaveBeenCalledWith({ id: a!.id, topic: "ai_job.requested", payload: a!.payload });
    for (const row of [a!, b!]) expect(row).toMatchObject({ attempts: 1, lastError: null, dispatchedAt: expect.any(Date) });

    expect(await dispatchDue(db, publish)).toEqual({ sent: 0, failed: 0 }); // nothing sent twice
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed publish for later, with backoff, and never stores the error text", async () => {
    await requestEdits(1);
    const outage = Object.assign(new Error("queue https://sqs… AccessDenied for arn:…"), { name: "QueueDoesNotExist" });
    expect(await dispatchDue(db, vi.fn().mockRejectedValue(outage))).toEqual({ sent: 0, failed: 1 });
    const [row] = await rows();
    expect(row).toMatchObject({ attempts: 1, dispatchedAt: null, lastError: "QueueDoesNotExist" });
    expect(row!.availableAt.getTime()).toBeGreaterThan(Date.now() + 2_000); // ≈5 s later

    // Not due yet: the next tick skips it.
    const publish = vi.fn().mockResolvedValue(undefined);
    expect(await dispatchDue(db, publish)).toEqual({ sent: 0, failed: 0 });
    // Once due, it goes out.
    await db.update(outboxEvents).set({ availableAt: sql`now() - interval '1 second'` });
    expect(await dispatchDue(db, publish)).toEqual({ sent: 1, failed: 0 });
  });

  it("two relays running at once (two app tasks) never publish the same event", async () => {
    await requestEdits(6);
    const seen: string[] = [];
    const publish = vi.fn(async (m: { id: string }) => {
      seen.push(m.id);
      await new Promise((r) => setTimeout(r, 30)); // hold the row lock for a moment
    });
    const results = await Promise.all([dispatchDue(db, publish), dispatchDue(db, publish), dispatchDue(db, publish)]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(6);
    expect(new Set(seen).size).toBe(6);
    expect(seen).toHaveLength(6);
  });

  it("gives up on an event after 20 failed attempts", async () => {
    await requestEdits(1);
    await db.update(outboxEvents).set({ attempts: 20 });
    const publish = vi.fn();
    expect(await dispatchDue(db, publish)).toEqual({ sent: 0, failed: 0 });
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("retryDelayMs", () => {
  it("doubles from 5 s, caps at 10 min, and adds ±20% jitter", () => {
    expect(retryDelayMs(1, () => 0.5)).toBe(5_000);
    expect(retryDelayMs(2, () => 0.5)).toBe(10_000);
    expect(retryDelayMs(4, () => 0.5)).toBe(40_000);
    expect(retryDelayMs(30, () => 0.5)).toBe(600_000);
    expect(retryDelayMs(1, () => 0)).toBe(4_000);
    expect(retryDelayMs(1, () => 1)).toBe(6_000);
  });
});
