import { beforeEach, describe, expect, it, vi } from "vitest";
import { Failure } from "@/server/core/failures";
import type { PageDetail } from "@/server/core/pages";
import { MEMBER, THREAD_ID, VERSION_ID, ctx, getRequest, jsonRequest } from "./mocks";

const m = vi.hoisted(() => ({
  currentActor: vi.fn(),
  createPage: vi.fn(),
  getPage: vi.fn(),
  addVersion: vi.fn(),
  openThread: vi.fn(),
  listThreads: vi.fn(),
  postMessage: vi.fn(),
  exportReview: vi.fn(),
}));

vi.mock("@/server/auth/current-actor", () => ({ currentActor: m.currentActor }));
vi.mock("@/server/db/connection", () => ({ getDb: () => ({}) }));
vi.mock("@/server/core/pages", () => ({
  createPage: m.createPage,
  getPage: m.getPage,
  // The real helper is pure; keep its behaviour.
  defaultVersion: (d: PageDetail) => d.versions.find((v) => v.state === "live") ?? d.versions[0]!,
}));
vi.mock("@/server/core/versions", () => ({ addVersion: m.addVersion }));
vi.mock("@/server/core/threads", () => ({
  openThread: m.openThread,
  listThreads: m.listThreads,
  postMessage: m.postMessage,
}));
vi.mock("@/server/core/export", () => ({ exportReview: m.exportReview }));

const { GET: health } = await import("@/app/api/health/route");
const { POST: createPageRoute } = await import("@/app/api/pages/route");
const { POST: addVersionRoute } = await import("@/app/api/pages/[shortId]/versions/route");
const threadsRoute = await import("@/app/api/pages/[shortId]/threads/route");
const { POST: messageRoute } = await import("@/app/api/threads/[threadId]/messages/route");
const { GET: reviewRoute } = await import("@/app/api/versions/[versionId]/review.md/route");

const V1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const V2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const V3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const version = (id: string, number: number, state: "draft" | "live") => ({
  id,
  number,
  state,
  origin: "upload" as const,
  createdAt: "2026-09-01T00:00:00.000Z",
});
const DETAIL: PageDetail = {
  id: "page-id",
  shortId: "abcdefghij",
  title: "Pricing",
  ownerName: "Ada",
  isOwner: true,
  versions: [version(V3, 3, "draft"), version(V2, 2, "live"), version(V1, 1, "draft")],
};

beforeEach(() => {
  vi.resetAllMocks();
  m.currentActor.mockResolvedValue(MEMBER);
});

describe("GET /api/health", () => {
  it("answers without auth or database", async () => {
    const res = await health(getRequest("/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.currentActor).not.toHaveBeenCalled();
  });

  it("?db=1 reports an unreachable database as 503 without leaking the error", async () => {
    // The mocked getDb() returns {} here, so execute() throws like a broken connection would.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await health(getRequest("/api/health?db=1"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: "unavailable" });
    spy.mockRestore();
  });
});

describe("body whitelisting", () => {
  it("POST /api/pages forwards only title and html", async () => {
    m.createPage.mockResolvedValue({ shortId: "abcdefghij", versionId: V1, versionNumber: 1 });
    const res = await createPageRoute(
      jsonRequest("/api/pages", { title: "T", html: "<p>x</p>", ownerMemberId: "someone-else", id: "x" }),
      ctx({}),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ shortId: "abcdefghij", versionNumber: 1 });
    expect(m.createPage).toHaveBeenCalledWith({}, MEMBER, { title: "T", html: "<p>x</p>" });
  });

  it("POST /api/pages/[shortId]/versions takes the page from the URL and only html from the body", async () => {
    m.addVersion.mockResolvedValue({ versionId: V2, number: 2 });
    const res = await addVersionRoute(
      jsonRequest("/api/pages/abcdefghij/versions", {
        html: "<p>2</p>",
        shortId: "other",
        pageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        basedOnVersionId: V1,
        state: "live",
      }),
      ctx({ shortId: "abcdefghij" }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ versionId: V2, number: 2 });
    expect(m.addVersion).toHaveBeenCalledWith({}, MEMBER, { shortId: "abcdefghij", html: "<p>2</p>" });
  });

  it("POST /api/pages/[shortId]/threads never forwards claudeRequestedAt or other extras", async () => {
    m.getPage.mockResolvedValue(DETAIL);
    m.openThread.mockResolvedValue({ threadId: THREAD_ID, claudeRequested: false });
    const res = await threadsRoute.POST(
      jsonRequest("/api/pages/abcdefghij/threads", {
        versionId: V3,
        posX: 0.25,
        posY: 0.5,
        targetPath: "body > main:nth-of-type(1)",
        excerpt: "Hello",
        text: "Looks off",
        claudeRequestedAt: "2026-01-01T00:00:00Z",
        closedAt: "2026-01-01T00:00:00Z",
        pageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
      ctx({ shortId: "abcdefghij" }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ threadId: THREAD_ID, claudeRequested: false });
    const input = m.openThread.mock.calls[0]![2] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["excerpt", "posX", "posY", "targetPath", "text", "versionId"]);
    expect(input).toEqual({
      versionId: V3,
      posX: 0.25,
      posY: 0.5,
      targetPath: "body > main:nth-of-type(1)",
      excerpt: "Hello",
      text: "Looks off",
    });
  });

  it("POST /api/pages/[shortId]/threads 404s a version that isn't on the page in the URL", async () => {
    m.getPage.mockResolvedValue(DETAIL);
    for (const versionId of [7, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"]) {
      const res = await threadsRoute.POST(
        jsonRequest("/api/pages/abcdefghij/threads", { versionId, posX: 0, posY: 0, text: "x" }),
        ctx({ shortId: "abcdefghij" }),
      );
      expect(res.status).toBe(404);
    }
    expect(m.openThread).not.toHaveBeenCalled();
  });

  it("POST /api/threads/[threadId]/messages takes the thread from the URL and only text from the body", async () => {
    m.postMessage.mockResolvedValue({ messageId: "m1", seq: 2 });
    const res = await messageRoute(
      jsonRequest(`/api/threads/${THREAD_ID}/messages`, {
        text: "Agreed",
        threadId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        authorKind: "assistant",
      }),
      ctx({ threadId: THREAD_ID }),
    );
    expect(res.status).toBe(201);
    expect(m.postMessage).toHaveBeenCalledWith({}, MEMBER, { threadId: THREAD_ID, text: "Agreed" });
  });
});

describe("GET /api/pages/[shortId]/threads", () => {
  it("defaults to the live version", async () => {
    m.getPage.mockResolvedValue(DETAIL);
    m.listThreads.mockResolvedValue([]);
    const res = await threadsRoute.GET(getRequest("/api/pages/abcdefghij/threads"), ctx({ shortId: "abcdefghij" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ versionId: V2, versionNumber: 2, threads: [] });
    expect(m.getPage).toHaveBeenCalledWith({}, MEMBER, "abcdefghij");
    expect(m.listThreads).toHaveBeenCalledWith({}, MEMBER, V2);
  });

  it("picks the version from ?n=", async () => {
    m.getPage.mockResolvedValue(DETAIL);
    m.listThreads.mockResolvedValue([]);
    await threadsRoute.GET(getRequest("/api/pages/abcdefghij/threads?n=1"), ctx({ shortId: "abcdefghij" }));
    expect(m.listThreads).toHaveBeenCalledWith({}, MEMBER, V1);
  });

  it("404s for a version number the page doesn't have", async () => {
    m.getPage.mockResolvedValue(DETAIL);
    const res = await threadsRoute.GET(getRequest("/api/pages/abcdefghij/threads?n=9"), ctx({ shortId: "abcdefghij" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "missing", message: "Version not found" } });
    expect(m.listThreads).not.toHaveBeenCalled();
  });

  it("400s for a non-numeric ?n=", async () => {
    m.getPage.mockResolvedValue(DETAIL);
    const res = await threadsRoute.GET(getRequest("/api/pages/abcdefghij/threads?n=abc"), ctx({ shortId: "abcdefghij" }));
    expect(res.status).toBe(400);
  });

  it("404s for an unknown page", async () => {
    m.getPage.mockRejectedValue(new Failure("missing", "Page not found"));
    const res = await threadsRoute.GET(getRequest("/api/pages/nope/threads"), ctx({ shortId: "nope" }));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/versions/[versionId]/review.md", () => {
  it("returns a Markdown attachment built by core from the app origin", async () => {
    vi.stubEnv("APP_BASE_URL", "https://draftpage.example");
    m.exportReview.mockResolvedValue({ markdown: "# Review: Pricing\n", filename: "review-abcdefghij-v3.md" });
    const res = await reviewRoute(getRequest(`/api/versions/${V3}/review.md`), ctx({ versionId: V3 }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="review-abcdefghij-v3.md"');
    expect(await res.text()).toBe("# Review: Pricing\n");
    expect(m.exportReview).toHaveBeenCalledWith({}, MEMBER, V3, "https://draftpage.example");
    vi.unstubAllEnvs();
  });

  it("maps core failures to JSON errors", async () => {
    m.exportReview.mockRejectedValue(new Failure("missing", "Version not found"));
    const res = await reviewRoute(getRequest(`/api/versions/${VERSION_ID}/review.md`), ctx({ versionId: VERSION_ID }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "missing", message: "Version not found" } });
  });

  it("401s when signed out", async () => {
    m.currentActor.mockRejectedValue(new Failure("unauthenticated", "Sign in required"));
    const res = await reviewRoute(getRequest(`/api/versions/${V3}/review.md`), ctx({ versionId: V3 }));
    expect(res.status).toBe(401);
    expect(m.exportReview).not.toHaveBeenCalled();
  });
});
