"use client";

import { useRef, type ReactNode } from "react";
import { belowPosition, popoverPosition, type Point, type Size } from "./geometry";
import { useElementSize } from "./hooks";

const WIDTH = 320;

/**
 * A popover placed next to a point on the canvas: right of it by default, flipped left near
 * the right edge, kept inside the canvas. Without a point (marker hidden) it docks top-right.
 */
export function FloatingPanel({
  anchor,
  box,
  label,
  placement = "side",
  children,
}: {
  anchor: Point | null;
  box: Size;
  label: string;
  /** "side": next to a marker. "below": under a text selection, so the text stays visible. */
  placement?: "side" | "below";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const own = useElementSize(ref);
  const width = Math.min(WIDTH, Math.max(box.w - 16, 220));
  const size = { w: width, h: own.h };
  const pos = anchor
    ? placement === "below"
      ? belowPosition(anchor, size, box)
      : popoverPosition(anchor, size, box)
    : { left: Math.max(8, box.w - width - 12), top: 12 };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      data-dp-floating=""
      style={{ left: pos.left, top: pos.top, width, maxHeight: Math.max(180, box.h - 24) }}
      className="dp-pop pointer-events-auto absolute z-20 flex flex-col overflow-hidden rounded-xl bg-raised text-ink shadow-[var(--shadow-pop)]"
    >
      {children}
    </div>
  );
}
