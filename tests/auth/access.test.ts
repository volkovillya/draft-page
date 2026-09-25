import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_CLAIM, hasAccess, keepSessionClaims } from "@/server/auth/access";
import { actorFromSessionUser, type SessionUser } from "@/server/auth/current-actor";
import { members } from "@/server/db/tables";
import { closeTestDb, failureCode, reset, testDb } from "../helpers/db";

const granted = (user: SessionUser): SessionUser => ({ ...user, [ACCESS_CLAIM]: true });

describe("hasAccess", () => {
  const base = { email: "alice@example.com", email_verified: true };

  it("requires the Auth0 access claim to be exactly true", () => {
    expect(hasAccess({ ...base, [ACCESS_CLAIM]: true })).toBe(true);
    expect(hasAccess(base)).toBe(false);
    expect(hasAccess({ ...base, [ACCESS_CLAIM]: "true" })).toBe(false);
    expect(hasAccess({ ...base, [ACCESS_CLAIM]: 1 })).toBe(false);
    expect(hasAccess({ ...base, [ACCESS_CLAIM]: false })).toBe(false);
  });

  it("still requires a verified, present email", () => {
    expect(hasAccess({ [ACCESS_CLAIM]: true, email: "alice@example.com", email_verified: false })).toBe(false);
    expect(hasAccess({ [ACCESS_CLAIM]: true, email: "alice@example.com" })).toBe(false);
    expect(hasAccess({ [ACCESS_CLAIM]: true, email: "", email_verified: true })).toBe(false);
    expect(hasAccess({ [ACCESS_CLAIM]: true, email_verified: true })).toBe(false);
  });
});

describe("keepSessionClaims", () => {
  it("keeps standard profile claims and the access claim, drops everything else", () => {
    const kept = keepSessionClaims({
      sub: "auth0|a",
      email: "a@example.com",
      email_verified: true,
      name: "A",
      picture: "p",
      [ACCESS_CLAIM]: true,
      sid: "session-id",
      "https://other/claim": "x",
      iss: "https://tenant",
    });
    expect(Object.keys(kept).sort()).toEqual(
      ["email", "email_verified", "name", "picture", "sub", ACCESS_CLAIM].sort(),
    );
  });
});

describe("actorFromSessionUser", () => {
  const db = testDb();
  beforeEach(reset);
  afterAll(closeTestDb);

  it("upserts a member that carries the access claim", async () => {
    const actor = await actorFromSessionUser(
      db,
      granted({ sub: "auth0|alice", email: "Alice@Example.com", email_verified: true, name: "Alice A", picture: "https://x/p.png" }),
    );
    expect(actor).toEqual({ kind: "member", memberId: "auth0|alice", email: "alice@example.com", name: "Alice A" });
    const row = await db.query.members.findFirst({ where: eq(members.id, "auth0|alice") });
    expect(row).toMatchObject({ email: "alice@example.com", name: "Alice A", pictureUrl: "https://x/p.png" });
  });

  it("refreshes the stored name on a later sign-in", async () => {
    const user = { sub: "auth0|alice", email: "alice@example.com", email_verified: true };
    await actorFromSessionUser(db, granted({ ...user, name: "Alice" }));
    const again = await actorFromSessionUser(db, granted({ ...user, name: "Alice Renamed" }));
    expect(again.name).toBe("Alice Renamed");
    const rows = await db.select().from(members);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Alice Renamed");
  });

  it("fails closed without the claim (e.g. the Auth0 Action is missing) and stores nothing", async () => {
    const code = await failureCode(
      actorFromSessionUser(db, { sub: "auth0|eve", email: "eve@example.com", email_verified: true, name: "Eve" }),
    );
    expect(code).toBe("not_allowed");
    expect(await db.select().from(members)).toHaveLength(0);
  });

  it("refuses an unverified email even with the claim", async () => {
    const code = await failureCode(
      actorFromSessionUser(db, granted({ sub: "auth0|alice", email: "alice@example.com", email_verified: false })),
    );
    expect(code).toBe("not_allowed");
  });

  it("falls back to the email local-part when the name looks like an email", async () => {
    const actor = await actorFromSessionUser(
      db,
      granted({ sub: "auth0|alice", email: "alice@example.com", email_verified: true, name: "alice@example.com" }),
    );
    expect(actor.name).toBe("alice");
  });

  it("prefers given_name / nickname over an email-like name", async () => {
    const actor = await actorFromSessionUser(
      db,
      granted({ sub: "auth0|alice", email: "alice@example.com", email_verified: true, name: "a@b.c", nickname: "ally" }),
    );
    expect(actor.name).toBe("ally");
  });
});
