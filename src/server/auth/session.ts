import { cookies } from "next/headers";
import { auth0 } from "./auth0";
import type { SessionUser } from "./current-actor";
import { DEV_SESSION_COOKIE, DEV_USER, devAuthEnabled } from "./dev-auth";

/** The signed-in user for this request, or null. The single place that reads the session. */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (devAuthEnabled()) {
    const jar = await cookies();
    return jar.get(DEV_SESSION_COOKIE)?.value === "1" ? DEV_USER : null;
  }
  const session = await auth0().getSession();
  return session ? (session.user as SessionUser) : null;
}
