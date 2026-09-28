import { eq } from "drizzle-orm";
import { getDb, type Db } from "../db/connection";
import { members } from "../db/tables";
import type { MemberActor } from "../core/actor";
import { notAllowed, unauthenticated } from "../core/failures";
import { upsertMember } from "../core/members";
import { getSessionUser } from "./session";
import { hasAccess } from "./access";

export type SessionUser = {
  sub: string;
  email?: string | null;
  email_verified?: boolean | null;
  name?: string | null;
  given_name?: string | null;
  nickname?: string | null;
  picture?: string | null;
  [claim: string]: unknown;
};

/** Turns an Auth0 session user into a member actor. Requires the access claim stamped by Auth0. */
export async function actorFromSessionUser(db: Db, user: SessionUser): Promise<MemberActor> {
  if (!hasAccess(user)) throw notAllowed("This account doesn't have access");
  const email = user.email!.trim().toLowerCase();
  const name = displayName(user);
  const existing = await db.query.members.findFirst({ where: eq(members.id, user.sub) });
  if (existing && existing.email === email && existing.name === name) {
    return { kind: "member", memberId: existing.id, email, name };
  }
  return upsertMember(db, { id: user.sub, email, name, pictureUrl: user.picture ?? null });
}

/** The signed-in member for this request, or a thrown `unauthenticated` / `not_allowed` failure. */
export async function currentActor(): Promise<MemberActor> {
  const user = await getSessionUser();
  if (!user) throw unauthenticated();
  return actorFromSessionUser(getDb(), user);
}

function displayName(user: SessionUser): string {
  const candidates = [user.name, user.given_name, user.nickname];
  const name = candidates.find((c) => c?.trim() && !c.includes("@"));
  return (name ?? user.email!.split("@")[0]!).trim().slice(0, 100);
}
