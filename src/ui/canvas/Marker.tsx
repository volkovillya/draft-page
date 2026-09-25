"use client";

import { memo } from "react";
import type { Cluster } from "./geometry";

// A pin: its square bottom-left corner sits on the anchor point, so it never covers the
// text it points at. Same size as PIN_SIZE in geometry.ts.
const disc =
  "pointer-events-auto absolute flex h-[26px] min-w-[26px] -translate-y-full origin-bottom-left items-center justify-center " +
  "rounded-[13px_13px_13px_3px] px-1.5 text-[11px] font-semibold tabular-nums ring-2 ring-white " +
  "shadow-[0_1px_3px_rgb(0_0_0/0.3),0_4px_10px_-2px_rgb(0_0_0/0.25)] transition-transform duration-150 hover:scale-110 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-marker";

/** One thread's numbered disc (muted when resolved), or a count badge for a cluster. */
export const Marker = memo(function Marker({
  cluster,
  selectedId,
  onActivate,
}: {
  cluster: Cluster;
  selectedId: string | null;
  onActivate: (cluster: Cluster) => void;
}) {
  const { items } = cluster;
  const selected = selectedId !== null && items.some((i) => i.id === selectedId);
  const halo = selected
    ? " z-10 scale-110 shadow-[0_0_0_5px_color-mix(in_srgb,var(--color-marker)_28%,transparent),0_4px_12px_-2px_rgb(0_0_0/0.3)]"
    : "";
  const style = { left: cluster.x, top: cluster.y };

  if (items.length === 1) {
    const item = items[0]!;
    const label = `Thread ${item.number}, ${item.closed ? "resolved" : "open"}`;
    return (
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected}
        title={label}
        style={style}
        onClick={() => onActivate(cluster)}
        className={disc + halo + (item.closed ? " bg-[#8b8a84] text-white" : " bg-marker text-marker-ink")}
      >
        {item.number}
      </button>
    );
  }

  const label = `${items.length} threads here: ${items.map((i) => i.number).join(", ")}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      style={style}
      onClick={() => onActivate(cluster)}
      className={disc + halo + " bg-[#1f1e1d] text-white"}
    >
      +{items.length}
    </button>
  );
});
