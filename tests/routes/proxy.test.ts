import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const middleware = vi.hoisted(() => vi.fn());
vi.mock("@/server/auth/auth0", () => ({ auth0: () => ({ middleware }) }));

const { proxy, config } = await import("@/proxy");

beforeEach(() => {
  middleware.mockReset();
  middleware.mockResolvedValue(NextResponse.next());
});

describe("proxy", () => {
  it("sends Auth0 callback errors to /denied with the reason", async () => {
    const res = await proxy(
      new NextRequest("http://localhost:6500/auth/callback?error=access_denied&error_description=Not%20on%20the%20list&state=s"),
    );
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/denied");
    expect(location.searchParams.get("reason")).toBe("Not on the list");
    expect(middleware).not.toHaveBeenCalled();
  });

  it("builds the redirect from APP_BASE_URL, not the internal Host header behind API Gateway", async () => {
    vi.stubEnv("APP_BASE_URL", "https://abc123.execute-api.eu-north-1.amazonaws.com");
    try {
      const res = await proxy(new NextRequest("http://10.20.0.37:3000/auth/callback?error=access_denied"));
      const location = new URL(res.headers.get("location")!);
      expect(location.origin).toBe("https://abc123.execute-api.eu-north-1.amazonaws.com");
      expect(location.pathname).toBe("/denied");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("falls back to the error code when there's no description", async () => {
    const res = await proxy(new NextRequest("http://localhost:6500/auth/callback?error=access_denied"));
    expect(new URL(res.headers.get("location")!).searchParams.get("reason")).toBe("access_denied");
  });

  it("hands everything else to the Auth0 middleware", async () => {
    const req = new NextRequest("http://localhost:6500/auth/callback?code=abc&state=s");
    await proxy(req);
    expect(middleware).toHaveBeenCalledWith(req);
  });

  it("skips static assets and /api/health", () => {
    const re = new RegExp(`^${config.matcher[0]}$`);
    expect(re.test("/pages")).toBe(true);
    expect(re.test("/api/pages")).toBe(true);
    expect(re.test("/_next/static/chunk.js")).toBe(false);
    expect(re.test("/api/health")).toBe(false);
  });
});
