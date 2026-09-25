import { describe, expect, it } from "vitest";
import { belowPosition, clusterMarkers, popoverPosition, splitMention } from "@/ui/canvas/geometry";
import { readFrameMessage } from "@/ui/canvas/protocol";

describe("readFrameMessage (parent side validation)", () => {
  it("accepts well-formed, tagged messages", () => {
    expect(readFrameMessage({ dp: 1, type: "ready", docW: 800, docH: 2000 })).toEqual({
      type: "ready",
      docW: 800,
      docH: 2000,
    });
    expect(readFrameMessage({ dp: 1, type: "scroll", x: 0, y: 120 })).toEqual({ type: "scroll", x: 0, y: 120 });
    expect(
      readFrameMessage({ dp: 1, type: "pick", posX: 0.2, posY: 1, targetPath: "body > p:nth-of-type(1)", clientX: 5, clientY: 6 }),
    ).toEqual({ type: "pick", posX: 0.2, posY: 1, targetPath: "body > p:nth-of-type(1)", excerpt: null, clientX: 5, clientY: 6 });
    expect(
      readFrameMessage({ dp: 1, type: "places", places: [{ threadId: "t", x: -20, y: 30, visible: false }] }),
    ).toEqual({ type: "places", places: [{ threadId: "t", x: -20, y: 30, visible: false }] });
  });

  it("rejects untagged, unknown or malformed messages", () => {
    const bad: unknown[] = [
      null,
      "ready",
      { type: "ready", docW: 1, docH: 1 },
      { dp: 2, type: "ready", docW: 1, docH: 1 },
      { dp: 1, type: "eval", code: "x" },
      { dp: 1, type: "ready", docW: Number.POSITIVE_INFINITY, docH: 1 },
      { dp: 1, type: "size", docW: -1, docH: 1 },
      { dp: 1, type: "scroll", x: "1", y: 0 },
      { dp: 1, type: "pick", posX: 2.5, posY: 0, targetPath: null, clientX: 0, clientY: 0 },
      { dp: 1, type: "pick", posX: -1.5, posY: 0, targetPath: null, clientX: 0, clientY: 0 },
      { dp: 1, type: "pick", posX: 0, posY: Number.NaN, targetPath: null, clientX: 0, clientY: 0 },
      { dp: 1, type: "pick", posX: 0, posY: 0, targetPath: "x".repeat(513), clientX: 0, clientY: 0 },
      { dp: 1, type: "pick", posX: 0, posY: 0, targetPath: null, excerpt: "e".repeat(501), clientX: 0, clientY: 0 },
      { dp: 1, type: "pick", posX: 0, posY: 0, targetPath: 7, clientX: 0, clientY: 0 },
      { dp: 1, type: "places", places: "nope" },
      { dp: 1, type: "places", places: [{ threadId: "", x: 0, y: 0, visible: true }] },
      { dp: 1, type: "places", places: [{ threadId: "t", x: 0, y: 0, visible: "yes" }] },
      { dp: 1, type: "places", places: [{ threadId: "t", x: 1e9, y: 0, visible: true }] },
    ];
    for (const message of bad) expect(readFrameMessage(message), JSON.stringify(message)).toBeNull();
  });
});

describe("clusterMarkers", () => {
  it("merges markers within 24px and keeps others apart", () => {
    const clusters = clusterMarkers([
      { id: "a", number: 1, closed: false, x: 100, y: 100 },
      { id: "b", number: 2, closed: false, x: 110, y: 115 },
      { id: "c", number: 3, closed: true, x: 200, y: 100 },
      { id: "d", number: 4, closed: false, x: 100, y: 124 },
    ]);
    expect(clusters.map((c) => c.items.map((i) => i.id))).toEqual([["a", "b", "d"], ["c"]]);
    expect(clusters[0]).toMatchObject({ x: 100, y: 100 });
  });
});

describe("popoverPosition", () => {
  const box = { w: 1000, h: 700 };
  const size = { w: 320, h: 200 };

  it("sits to the right of the pin by default", () => {
    expect(popoverPosition({ x: 100, y: 100 }, size, box)).toEqual({ side: "right", left: 100 + 26 + 10, top: 100 - 26 });
  });

  it("flips left near the right edge", () => {
    const p = popoverPosition({ x: 900, y: 100 }, size, box);
    expect(p.side).toBe("left");
    expect(p.left).toBe(900 - 10 - 320);
  });

  it("stays inside the box", () => {
    const p = popoverPosition({ x: 5, y: 690 }, { w: 320, h: 300 }, { w: 300, h: 700 });
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.top).toBe(700 - 300 - 8);
  });
});

describe("splitMention", () => {
  it("finds a leading @Claude like the server trigger", () => {
    expect(splitMention("  @claude make it blue")).toEqual({ lead: "  ", mention: "@claude", rest: " make it blue" });
    expect(splitMention("@Claude")).not.toBeNull();
    expect(splitMention("hey @Claude")).toBeNull();
    expect(splitMention("@claudette")).toBeNull();
  });
});

describe("forwarded keys and taps", () => {
  it("accepts only Escape and c keys, and bare taps", () => {
    expect(readFrameMessage({ dp: 1, type: "key", key: "Escape" })).toEqual({ type: "key", key: "Escape" });
    expect(readFrameMessage({ dp: 1, type: "key", key: "c" })).toEqual({ type: "key", key: "c" });
    expect(readFrameMessage({ dp: 1, type: "key", key: "Enter" })).toBeNull();
    expect(readFrameMessage({ dp: 1, type: "tap" })).toEqual({ type: "tap" });
    expect(readFrameMessage({ type: "tap" })).toBeNull();
  });
});

describe("belowPosition", () => {
  const box = { w: 900, h: 700 };
  const size = { w: 320, h: 110 };
  it("sits under the selection end, shifted slightly left", () => {
    expect(belowPosition({ x: 500, y: 400 }, size, box)).toEqual({ left: 472, top: 412 });
  });
  it("flips above near the bottom and stays inside the box", () => {
    const pos = belowPosition({ x: 890, y: 680 }, size, box);
    expect(pos.top).toBeLessThan(680 - size.h);
    expect(pos.left).toBe(box.w - size.w - 8);
  });
});
