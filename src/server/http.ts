import { NextResponse } from "next/server";
import type { MemberActor } from "./core/actor";
import { Failure, httpStatusFor } from "./core/failures";
import { currentActor } from "./auth/current-actor";

type Handler<C> = (actor: MemberActor, request: Request, context: C) => Promise<Response>;

/**
 * Wraps a route handler: resolves the signed-in member, maps domain failures to
 * JSON errors (`{ error: { code, message } }`), and hides unexpected errors.
 */
export function withMember<C>(handler: Handler<C>) {
  return async (request: Request, context: C): Promise<Response> => {
    if (crossSiteWrite(request)) {
      return NextResponse.json({ error: { code: "not_allowed", message: "Cross-site request refused" } }, { status: 403 });
    }
    try {
      const actor = await currentActor();
      return await handler(actor, request, context);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF guard on top of the SameSite=Lax session cookie. Browsers send Origin with every
 * cross-site write (and "null" from sandboxed frames), so a write whose Origin isn't this
 * app is refused. A request without Origin didn't come from a web page (curl, tests).
 */
export function crossSiteWrite(request: Request, appBaseUrl = process.env.APP_BASE_URL): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  const allowed = new Set([new URL(request.url).origin]);
  try {
    if (appBaseUrl) allowed.add(new URL(appBaseUrl).origin);
  } catch {
    // A malformed APP_BASE_URL only means fewer allowed origins.
  }
  return !allowed.has(origin);
}

export function errorResponse(error: unknown): Response {
  if (error instanceof Failure) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: httpStatusFor[error.code] },
    );
  }
  console.error(JSON.stringify({ level: "error", msg: "unhandled route error", err: String(error) }));
  return NextResponse.json(
    { error: { code: "internal", message: "Something went wrong" } },
    { status: 500 },
  );
}

/** Reads a JSON body, turning malformed JSON into a 400 instead of a 500. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new Failure("invalid", "Request body must be a JSON object");
}
