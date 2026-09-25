import { cache } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { currentActor } from "@/server/auth/current-actor";
import type { MemberActor } from "@/server/core/actor";
import { Failure } from "@/server/core/failures";

/**
 * The signed-in member for a server page. Signed out → /auth/login, not on the
 * no access claim → /denied. Deduplicated per request, so layouts and pages can both call it.
 */
export const requireMemberPage = cache(async (): Promise<MemberActor> => {
  // Opt out of prerendering before touching Auth0 (the build has no Auth0 env).
  await connection();
  let outcome: MemberActor | "unauthenticated" | "not_allowed";
  try {
    outcome = await currentActor();
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    if (error.code === "unauthenticated") outcome = "unauthenticated";
    else if (error.code === "not_allowed") outcome = "not_allowed";
    else throw error;
  }
  // redirect() throws, so it stays outside the try block.
  if (outcome === "unauthenticated") redirect("/auth/login");
  if (outcome === "not_allowed") redirect("/denied");
  return outcome;
});
