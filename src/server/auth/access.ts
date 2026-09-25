/**
 * Access is decided in Auth0, not here. A post-login Action checks the email against the
 * list kept in Auth0 and stamps this claim on the ID token. The app only requires the claim,
 * so if the Action is missing or broken nobody gets in (fail closed).
 */
export const ACCESS_CLAIM = "https://draftpage/claims/access";

/** Standard OIDC claims kept in the session, plus DraftPage's access claim. Everything else is dropped. */
const KEPT_CLAIMS = new Set([
  "sub",
  "name",
  "nickname",
  "given_name",
  "family_name",
  "picture",
  "email",
  "email_verified",
  ACCESS_CLAIM,
]);

export function keepSessionClaims<T extends Record<string, unknown>>(user: T): Partial<T> {
  return Object.fromEntries(Object.entries(user).filter(([key]) => KEPT_CLAIMS.has(key))) as Partial<T>;
}

export function hasAccess(user: Record<string, unknown>): boolean {
  return (
    user[ACCESS_CLAIM] === true &&
    user.email_verified === true &&
    typeof user.email === "string" &&
    user.email.trim().length > 0
  );
}
