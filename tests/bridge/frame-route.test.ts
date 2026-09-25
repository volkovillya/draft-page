import { beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeScript } from "@/frame-bridge/bridge";
import type { MemberActor } from "@/server/core/actor";
import { Failure } from "@/server/core/failures";

const m = vi.hoisted(() => ({ currentActor: vi.fn(), getVersionHtml: vi.fn() }));

vi.mock("@/server/auth/current-actor", () => ({ currentActor: m.currentActor }));
vi.mock("@/server/db/connection", () => ({ getDb: () => ({}) }));
vi.mock("@/server/core/versions", () => ({ getVersionHtml: m.getVersionHtml }));

const { GET } = await import("@/app/api/versions/[versionId]/frame/route");

const MEMBER: MemberActor = { kind: "member", memberId: "auth0|m1", email: "ada@example.com", name: "Ada" };
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const call = (versionId = VERSION_ID) =>
  GET(new Request(`http://localhost/api/versions/${versionId}/frame`), {
    params: Promise.resolve({ versionId }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  m.currentActor.mockResolvedValue(MEMBER);
});

describe("GET /api/versions/[versionId]/frame", () => {
  it("serves the HTML with the bridge and the sandbox headers", async () => {
    m.getVersionHtml.mockResolvedValue({ html: "<html><body><h1>Hi</h1></body></html>", pageId: "p", number: 1 });
    const res = await call();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts; frame-ancestors 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe(`<html><body><h1>Hi</h1>${bridgeScript()}</body></html>`);
    expect(m.getVersionHtml).toHaveBeenCalledWith({}, MEMBER, VERSION_ID);
  });

  it("returns 401 JSON when signed out, without reading the version", async () => {
    m.currentActor.mockRejectedValue(new Failure("unauthenticated", "Sign in required"));
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in required" } });
    expect(m.getVersionHtml).not.toHaveBeenCalled();
  });

  it("maps a missing version to 404", async () => {
    m.getVersionHtml.mockRejectedValue(new Failure("missing", "Version not found"));
    const res = await call();
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("missing");
  });
});
