import { ACCESS_CLAIM } from "./access";
import type { SessionUser } from "./current-actor";

/**
 * TEMPORARY local sign-in for working without an Auth0 tenant.
 *
 * Active only when BOTH hold:
 *   - NODE_ENV === "development" (i.e. `npm run dev`; never `next build` / `next start`), and
 *   - DRAFTPAGE_DEV_AUTH=on in .env.local.
 * Remove this file and its call sites once Auth0 is set up.
 */
export function devAuthEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "development" && env.DRAFTPAGE_DEV_AUTH === "on";
}

export const DEV_SESSION_COOKIE = "draftpage_dev_session";

export const DEV_USER: SessionUser = {
  sub: "dev|local",
  email: "dev@draftpage.local",
  email_verified: true,
  name: "Local Dev",
  [ACCESS_CLAIM]: true,
};

/** Only same-site relative paths are allowed as a post-login destination. */
export function safeReturnTo(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/pages";
}
