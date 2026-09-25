"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// A document's navigation type never changes, so the back/forward check runs once per load.
let checkedNavigation = false;

/**
 * Browsers restore pages from history without asking the server (back/forward cache, or the
 * HTTP cache for `no-cache` documents), which can show data from before a change such as
 * publishing. This refetches the server components whenever the page comes back that way.
 */
export function useRefreshOnHistoryReturn() {
  const router = useRouter();
  useEffect(() => {
    if (!checkedNavigation) {
      checkedNavigation = true;
      const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (entry?.type === "back_forward") router.refresh();
    }
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) router.refresh();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [router]);
}

/** Drop-in for server-rendered pages (e.g. the gallery). */
export function RefreshOnHistoryReturn() {
  useRefreshOnHistoryReturn();
  return null;
}
