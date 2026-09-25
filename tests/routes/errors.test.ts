import { beforeEach, describe, expect, it, vi } from "vitest";
import { Failure, type FailureCode } from "@/server/core/failures";
import { MEMBER, THREAD_ID, VERSION_ID, ctx, getRequest, jsonRequest } from "./mocks";

const m = vi.hoisted(() => ({
  currentActor: vi.fn(),
  createPage: vi.fn(),
  deletePage: vi.fn(),
  publishVersion: vi.fn(),
  closeThread: vi.fn(),
  deleteMessage: vi.fn(),
  postMessage: vi.fn(),
}));

vi.mock("@/server/auth/current-actor", () => ({ currentActor: m.currentActor }));
vi.mock("@/server/db/connection", () => ({ getDb: () => ({}) }));
vi.mock("@/server/core/pages", () => ({ createPage: m.createPage, deletePage: m.deletePage }));
vi.mock("@/server/core/versions", () => ({ publishVersion: m.publishVersion }));
vi.mock("@/server/core/threads", () => ({
  closeThread: m.closeThread,
  deleteMessage: m.deleteMessage,
  postMessage: m.postMessage,
}));

const { POST: createPageRoute } = await import("@/app/api/pages/route");
const { DELETE: deletePageRoute } = await import("@/app/api/pages/[shortId]/route");
const { POST: publishRoute } = await import("@/app/api/versions/[versionId]/publish/route");
const { POST: closeRoute } = await import("@/app/api/threads/[threadId]/close/route");
const { POST: messageRoute } = await import("@/app/api/threads/[threadId]/messages/route");
const { DELETE: deleteMessageRoute } = await import("@/app/api/messages/[messageId]/route");

beforeEach(() => {
  vi.resetAllMocks();
  m.currentActor.mockResolvedValue(MEMBER);
});

describe("auth gating", () => {
  it("returns 401 with the error shape when signed out, without calling core", async () => {
    m.currentActor.mockRejectedValue(new Failure("unauthenticated", "Sign in required"));
    const res = await deletePageRoute(getRequest("/api/pages/abc", "DELETE"), ctx({ shortId: "abc" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in required" } });
    expect(m.deletePage).not.toHaveBeenCalled();
  });

  it("returns 403 when the account has no access", async () => {
    m.currentActor.mockRejectedValue(new Failure("not_allowed", "This account doesn't have access"));
    const res = await createPageRoute(jsonRequest("/api/pages", { title: "t", html: "<p>" }), ctx({}));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "not_allowed", message: "This account doesn't have access" },
    });
    expect(m.createPage).not.toHaveBeenCalled();
  });

  it("passes the resolved member actor to core", async () => {
    m.publishVersion.mockResolvedValue(undefined);
    const res = await publishRoute(getRequest(`/api/versions/${VERSION_ID}/publish`, "POST"), ctx({ versionId: VERSION_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.publishVersion).toHaveBeenCalledWith({}, MEMBER, VERSION_ID);
  });
});

describe("failure mapping", () => {
  const cases: [FailureCode, number][] = [
    ["unauthenticated", 401],
    ["not_allowed", 403],
    ["missing", 404],
    ["invalid", 400],
    ["conflict", 409],
  ];

  it.each(cases)("maps a core %s failure to HTTP %i", async (code, status) => {
    m.closeThread.mockRejectedValue(new Failure(code, `boom: ${code}`));
    const res = await closeRoute(getRequest(`/api/threads/${THREAD_ID}/close`, "POST"), ctx({ threadId: THREAD_ID }));
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: { code, message: `boom: ${code}` } });
  });

  it("hides unexpected errors behind a 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    m.deleteMessage.mockRejectedValue(new Error("connection string with secrets"));
    const res = await deleteMessageRoute(getRequest("/api/messages/x", "DELETE"), ctx({ messageId: "x" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "internal", message: "Something went wrong" } });
    expect(JSON.stringify(body)).not.toContain("secrets");
    spy.mockRestore();
  });
});

describe("malformed bodies", () => {
  it("turns invalid JSON into a 400", async () => {
    const res = await createPageRoute(jsonRequest("/api/pages", "{not json"), ctx({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid" } });
    expect(m.createPage).not.toHaveBeenCalled();
  });

  it.each([["[1,2]"], ["null"], ['"text"'], ["42"]])("rejects a non-object JSON body %s", async (raw) => {
    const res = await messageRoute(jsonRequest(`/api/threads/${THREAD_ID}/messages`, raw), ctx({ threadId: THREAD_ID }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid" } });
    expect(m.postMessage).not.toHaveBeenCalled();
  });

  it("rejects an empty body", async () => {
    const req = new Request("http://localhost/api/pages", { method: "POST" });
    const res = await createPageRoute(req, ctx({}));
    expect(res.status).toBe(400);
  });
});
