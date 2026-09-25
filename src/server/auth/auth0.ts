import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { keepSessionClaims } from "./access";

const DAY = 24 * 60 * 60;

// Created lazily so modules that import this file (e.g. in tests) don't need Auth0 env.
let client: Auth0Client | undefined;

export function auth0(): Auth0Client {
  client ??= new Auth0Client({
    authorizationParameters: { scope: "openid profile email" },
    signInReturnToPath: "/pages",
    // Access changes made in Auth0 take effect at the next sign-in, so keep sessions short.
    session: { rolling: true, inactivityDuration: DAY, absoluteDuration: 7 * DAY },
    // With this hook the SDK no longer filters claims itself, so we keep only what we use.
    beforeSessionSaved: async (session) => ({ ...session, user: keepSessionClaims(session.user) as typeof session.user }),
  });
  return client;
}
