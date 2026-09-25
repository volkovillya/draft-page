import { sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import { members } from "../db/tables";
import type { MemberActor } from "./actor";

export type MemberProfile = { id: string; email: string; name: string; pictureUrl: string | null };

/** Records (or refreshes) a member after sign-in and returns their actor. */
export async function upsertMember(db: Db, profile: MemberProfile): Promise<MemberActor> {
  await db
    .insert(members)
    .values({ ...profile, email: profile.email.toLowerCase() })
    .onConflictDoUpdate({
      target: members.id,
      set: {
        email: profile.email.toLowerCase(),
        name: profile.name,
        pictureUrl: profile.pictureUrl,
        seenAt: sql`now()`,
      },
    });
  return { kind: "member", memberId: profile.id, email: profile.email.toLowerCase(), name: profile.name };
}
