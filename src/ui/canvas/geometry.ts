/** Pure layout helpers for the canvas overlay (no React, unit-testable). */

export type Point = { x: number; y: number };
export type Size = { w: number; h: number };

export type MarkerItem = { id: string; number: number; closed: boolean; x: number; y: number };
export type Cluster = { key: string; x: number; y: number; items: MarkerItem[] };

export const CLUSTER_RADIUS = 24;

/**
 * Greedy clustering: markers (in number order) join the first cluster whose seed is within
 * `radius` px, otherwise they seed a new one. The cluster sits on its seed marker, so it
 * doesn't jump when later markers join.
 */
export function clusterMarkers(items: MarkerItem[], radius = CLUSTER_RADIUS): Cluster[] {
  const clusters: Cluster[] = [];
  const r2 = radius * radius;
  for (const item of items) {
    let home: Cluster | undefined;
    for (const c of clusters) {
      const dx = c.x - item.x;
      const dy = c.y - item.y;
      if (dx * dx + dy * dy <= r2) {
        home = c;
        break;
      }
    }
    if (home) home.items.push(item);
    else clusters.push({ key: item.id, x: item.x, y: item.y, items: [item] });
  }
  return clusters;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

/** A marker is a pin whose bottom-left corner is the anchor point; it extends up and right. */
export const PIN_SIZE = 26;

/**
 * Where to put a popover of `size` next to `anchor` inside `box`: to the right of the pin by
 * default, flipped to the left of the point when it would overflow the right edge, always
 * kept inside the box.
 */
export function popoverPosition(
  anchor: Point,
  size: Size,
  box: Size,
  gap = 10,
  margin = 8,
): { left: number; top: number; side: "right" | "left" } {
  let side: "right" | "left" = "right";
  let left = anchor.x + PIN_SIZE + gap;
  if (left + size.w > box.w - margin) {
    side = "left";
    left = anchor.x - gap - size.w;
  }
  return {
    side,
    left: clamp(left, margin, box.w - size.w - margin),
    top: clamp(anchor.y - PIN_SIZE, margin, box.h - size.h - margin),
  };
}

/**
 * Where to put a popover under a point (a text selection's end), flipped above it when it
 * would overflow the bottom, always kept inside the box.
 */
export function belowPosition(anchor: Point, size: Size, box: Size, gap = 12, margin = 8): { left: number; top: number } {
  let top = anchor.y + gap;
  if (top + size.h > box.h - margin) top = anchor.y - gap - size.h - 22;
  return {
    left: clamp(anchor.x - 28, margin, box.w - size.w - margin),
    top: clamp(top, margin, box.h - size.h - margin),
  };
}

/** Splits a leading "@Claude" mention (as the server's trigger parser sees it) from the rest. */
export function splitMention(text: string): { lead: string; mention: string; rest: string } | null {
  const match = /^(\s*)(@claude)\b/i.exec(text);
  if (!match) return null;
  return { lead: match[1]!, mention: match[2]!, rest: text.slice(match[0].length) };
}
