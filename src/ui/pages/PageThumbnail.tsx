"use client";

import { useEffect, useRef, useState } from "react";

// The page is laid out at a desktop viewport and scaled down to the card, like a screenshot.
const VIEW_W = 1280;
const VIEW_H = 800;

/**
 * A live, non-interactive thumbnail. The frame only loads once the card is near the
 * viewport, so a long gallery doesn't render (and run the scripts of) every page at once.
 * Same sandbox as the canvas: scripts only, opaque origin, no pointer events, not focusable.
 */
export function PageThumbnail({ versionId }: { versionId: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    const ro = new ResizeObserver(() => setScale(el.clientWidth / VIEW_W));
    ro.observe(el);
    return () => {
      io.disconnect();
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={box} className="absolute inset-0">
      {visible && scale > 0 ? (
        <iframe
          src={`/api/versions/${versionId}/frame`}
          sandbox="allow-scripts"
          tabIndex={-1}
          aria-hidden="true"
          title="Page preview"
          style={{ width: VIEW_W, height: VIEW_H, transform: `scale(${scale})` }}
          className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
        />
      ) : null}
    </div>
  );
}
