import type { BridgeAnchor, BridgePlace } from "@/frame-bridge/bridge";
import { inPosRange } from "@/frame-bridge/range";

/**
 * Parent side of the frame bridge protocol (spec §6). The frame runs untrusted HTML and can
 * post anything, so every message is validated field by field before use.
 */

export type FramePick = {
  posX: number;
  posY: number;
  targetPath: string | null;
  excerpt: string | null;
  clientX: number;
  clientY: number;
};

export type FrameMessage =
  | { type: "ready" | "size"; docW: number; docH: number }
  | { type: "scroll"; x: number; y: number }
  | ({ type: "pick" } & FramePick)
  | { type: "places"; places: BridgePlace[] }
  | { type: "key"; key: "Escape" | "c" }
  | { type: "tap" };

export type ParentMessage =
  | { dp: 1; type: "mode"; placing: boolean }
  | { dp: 1; type: "locate"; anchors: BridgeAnchor[] };

const MAX_COORD = 1_000_000; // px; anything beyond is nonsense
const MAX_PATH = 512;
const MAX_EXCERPT = 500;
const MAX_ID = 64;
const MAX_PLACES = 2000;

const coord = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
const size = (v: unknown): v is number => coord(v) && v >= 0;

export function readFrameMessage(data: unknown): FrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.dp !== 1 || typeof m.type !== "string") return null;
  switch (m.type) {
    case "ready":
    case "size":
      return size(m.docW) && size(m.docH) ? { type: m.type, docW: m.docW, docH: m.docH } : null;
    case "scroll":
      return coord(m.x) && coord(m.y) ? { type: "scroll", x: m.x, y: m.y } : null;
    case "pick": {
      if (!inPosRange(m.posX) || !inPosRange(m.posY) || !coord(m.clientX) || !coord(m.clientY)) return null;
      const targetPath = m.targetPath ?? null;
      if (targetPath !== null && (typeof targetPath !== "string" || targetPath.length > MAX_PATH)) return null;
      const excerpt = m.excerpt ?? null;
      if (excerpt !== null && (typeof excerpt !== "string" || excerpt.length > MAX_EXCERPT)) return null;
      return {
        type: "pick",
        posX: m.posX,
        posY: m.posY,
        targetPath: targetPath || null,
        excerpt: excerpt && excerpt.trim() ? excerpt : null,
        clientX: m.clientX,
        clientY: m.clientY,
      };
    }
    case "places": {
      if (!Array.isArray(m.places) || m.places.length > MAX_PLACES) return null;
      const places: BridgePlace[] = [];
      for (const p of m.places as unknown[]) {
        if (!p || typeof p !== "object") return null;
        const { threadId, x, y, visible } = p as Record<string, unknown>;
        if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > MAX_ID) return null;
        if (!coord(x) || !coord(y) || typeof visible !== "boolean") return null;
        places.push({ threadId, x, y, visible });
      }
      return { type: "places", places };
    }
    case "key":
      return m.key === "Escape" || m.key === "c" ? { type: "key", key: m.key } : null;
    case "tap":
      return { type: "tap" };
    default:
      return null;
  }
}
