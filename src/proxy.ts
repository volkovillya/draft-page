import { NextResponse, type NextRequest } from "next/server";
import { auth0 } from "@/server/auth/auth0";
import { DEV_SESSION_COOKIE, devAuthEnabled, safeReturnTo } from "@/server/auth/dev-auth";

const MAX_REASON_LENGTH = 300;

/**
 * Next 16 proxy: runs the Auth0 middleware (mounts /auth/* and rolls the session).
 * Auth0 callback errors, such as the access Action's `access_denied`, go to /denied
 * instead of the SDK's plain error response.
 */
export async function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  if (devAuthEnabled()) return devAuthProxy(request);
  if (pathname === "/auth/callback" && searchParams.has("error")) {
    const reason = (searchParams.get("error_description") || searchParams.get("error") || "")
      .slice(0, MAX_REASON_LENGTH);
    // Behind API Gateway the Host header is the task's internal address, so absolute
    // redirects are built from the public APP_BASE_URL, never from the incoming request.
    const target = new URL("/denied", process.env.APP_BASE_URL || request.nextUrl);
    if (reason) target.searchParams.set("reason", reason);
    return NextResponse.redirect(target);
  }
  return auth0().middleware(request);
}

/** TEMPORARY: local sign-in without Auth0 (see src/server/auth/dev-auth.ts). */
function devAuthProxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  if (pathname === "/auth/login") {
    const res = NextResponse.redirect(new URL(safeReturnTo(searchParams.get("returnTo")), request.nextUrl));
    res.cookies.set(DEV_SESSION_COOKIE, "1", { httpOnly: true, sameSite: "lax", path: "/" });
    return res;
  }
  if (pathname === "/auth/logout") {
    const res = NextResponse.redirect(new URL("/", request.nextUrl));
    res.cookies.delete(DEV_SESSION_COOKIE);
    return res;
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|api/health).*)",
  ],
};
