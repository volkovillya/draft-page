import { injectBridge } from "@/frame-bridge/bridge";
import { getVersionHtml } from "@/server/core/versions";
import { getDb } from "@/server/db/connection";
import { withMember } from "@/server/http";

/**
 * GET /api/versions/[versionId]/frame: the version's untrusted HTML plus the frame bridge,
 * served into the canvas iframe (`sandbox="allow-scripts"`, never `allow-same-origin`).
 *
 * Auth: plain session cookie, no token. Reasoning (checked against the Fetch/HTML specs
 * and RFC 6265bis):
 * - The iframe's navigation request is started by the canvas document, which is the app's
 *   own origin. The iframe's `sandbox` attribute and the CSP `sandbox` header only apply to
 *   the document that *results* from the navigation; they don't change how the request
 *   itself is classified. For a nested navigation the "site for cookies" comes from the
 *   frame's ancestors (the canvas and the top-level window), both same-site with this URL,
 *   so the request is same-site and the SameSite=Lax Auth0 session cookie is sent.
 * - Once loaded, the page runs in an opaque origin. Its own requests (fetch/XHR/img) have an
 *   opaque client origin, so they are cross-site: Lax cookies are withheld and CORS blocks
 *   reading any response. Forms, popups and top-level navigation are disabled by the
 *   sandbox (no allow-forms / allow-popups / allow-top-navigation), so no cookie-bearing
 *   POST can be forged. The worst it can do is navigate its own frame to another GET URL,
 *   which it still can't read (the frame stays sandboxed and opaque).
 * - `frame-ancestors 'self'` stops other sites from framing this route, and a cross-site
 *   embedder wouldn't receive the Lax cookie anyway.
 * So the smallest secure design is the existing member session; a signed `?t=` token would
 * add a secret to URLs (history, logs) without closing any additional hole.
 */
export const GET = withMember(
  async (actor, _request, context: { params: Promise<{ versionId: string }> }) => {
    const { versionId } = await context.params;
    const { html } = await getVersionHtml(getDb(), actor, versionId);
    return new Response(injectBridge(html), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "sandbox allow-scripts; frame-ancestors 'self'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "private, no-store",
      },
    });
  },
);
