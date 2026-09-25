import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { exportReview } from "@/server/core/export";
import { closeThread, openThread, postMessage } from "@/server/core/threads";
import { addVersion, publishVersion } from "@/server/core/versions";
import { assistantActor, closeTestDb, failureCode, makeMember, makePage, reset, testDb } from "../helpers/db";

const db = testDb();
const BASE = "http://localhost:6500/";

beforeEach(reset);
afterAll(closeTestDb);

describe("exportReview", () => {
  it("renders the title, version, excerpts, targets and messages", async () => {
    const owner = await makeMember({ name: "Olga" });
    const reviewer = await makeMember({ name: "Rui" });
    const page = await makePage(owner, "<p>x</p>", "Launch plan");

    const carried = await openThread(db, reviewer, {
      versionId: page.versionId,
      posX: 0.1,
      posY: 0.2,
      targetPath: "body > p:nth-of-type(1)",
      excerpt: "Old wording\nsecond line",
      text: "Reword this",
    });
    await postMessage(db, owner, { threadId: carried.threadId, text: "Will do\nsoon" });

    const v2 = await addVersion(db, owner, { shortId: page.shortId, html: "<p>y</p>" });
    await publishVersion(db, owner, v2.versionId);
    const claude = await openThread(db, owner, {
      versionId: v2.versionId,
      posX: 0.5,
      posY: 0.5,
      text: "@Claude tighten the intro",
    });
    await postMessage(db, assistantActor({ pageId: page.id, threadId: claude.threadId }), {
      threadId: claude.threadId,
      text: "Drafted v3",
    });
    const resolved = await openThread(db, reviewer, { versionId: v2.versionId, posX: 0.9, posY: 0.9, text: "Nit" });
    await closeThread(db, reviewer, resolved.threadId);

    const { markdown: md, filename } = await exportReview(db, reviewer, v2.versionId, BASE);
    const lines = md.split("\n");

    expect(lines[0]).toBe("# Review: Launch plan");
    expect(md).toContain("Version 2 (live) · 2 open, 1 resolved");
    expect(md).toContain(`Link: http://localhost:6500/pages/${page.shortId}?n=2`);
    expect(filename).toBe(`review-${page.shortId}-v2.md`);
    expect(md).toContain("open, from v1");
    expect(md).toContain("Target: `body > p:nth-of-type(1)`");
    expect(md).toContain("> Old wording\n> second line");
    expect(md).toContain("- **Rui:** Reword this");
    expect(md).toContain("- **Olga:** Will do\n  soon");
    expect(md).toContain("· Claude requested");
    expect(md).toContain("- **Olga:** @Claude tighten the intro");
    expect(md).toContain("- **Claude:** Drafted v3");
    expect(md).toContain("resolved");
    expect(md).toContain("- **Rui:** Nit");
    expect(lines.filter((l) => l.startsWith("## "))).toHaveLength(3);
  });

  it("works for a version with no threads", async () => {
    const owner = await makeMember();
    const page = await makePage(owner, "<p>x</p>", "Empty");
    const { markdown: md } = await exportReview(db, owner, page.versionId, BASE);
    expect(md).toContain("# Review: Empty");
    expect(md).toContain("Version 1 (draft) · 0 open, 0 resolved");
    expect(md).not.toContain("## ");
  });

  it("refuses the assistant and reports a missing version", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    expect(await failureCode(exportReview(db, assistantActor({ pageId: page.id }), page.versionId, BASE))).toBe(
      "not_allowed",
    );
    expect(await failureCode(exportReview(db, owner, "00000000-0000-4000-8000-000000000000", BASE))).toBe("missing");
  });
});

describe("exportReview numbering", () => {
  it("numbers threads oldest first, matching the canvas", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    await openThread(db, owner, { versionId: page.versionId, posX: 0.1, posY: 0.1, text: "older" });
    await openThread(db, owner, { versionId: page.versionId, posX: 0.2, posY: 0.2, text: "newer" });
    const { markdown } = await exportReview(db, owner, page.versionId, BASE);
    expect(markdown.indexOf("older")).toBeLessThan(markdown.indexOf("newer"));
    expect(markdown).toMatch(/## 1\. open\n\n- \*\*[^*]+:\*\* older/);
  });
});
