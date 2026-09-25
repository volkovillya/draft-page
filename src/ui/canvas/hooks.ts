"use client";

import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from "react";
import type { BridgePlace } from "@/frame-bridge/bridge";
import type { Size } from "./geometry";

/**
 * Marker positions reported by the frame. They change on every scroll frame, so they live
 * in a tiny external store: only the marker layer and open popovers re-render, not the
 * toolbar or the thread rail.
 */
export type PlacesStore = {
  get: () => ReadonlyMap<string, BridgePlace>;
  set: (places: BridgePlace[]) => void;
  subscribe: (listener: () => void) => () => void;
};

const EMPTY: ReadonlyMap<string, BridgePlace> = new Map();

export function createPlacesStore(): PlacesStore {
  let current: ReadonlyMap<string, BridgePlace> = EMPTY;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(places) {
      current = new Map(places.map((p) => [p.threadId, p]));
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const serverSnapshot = () => EMPTY;

export function usePlaces(store: PlacesStore): ReadonlyMap<string, BridgePlace> {
  return useSyncExternalStore(store.subscribe, store.get, serverSnapshot);
}

/** One anchor's place; re-renders only when that place changes. */
export function usePlace(store: PlacesStore, id: string | null): BridgePlace | undefined {
  return useSyncExternalStore(
    store.subscribe,
    () => (id ? store.get().get(id) : undefined),
    () => undefined,
  );
}

/** An element's rendered size, kept current with a ResizeObserver. */
export function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = Math.round(el.offsetWidth);
      const h = Math.round(el.offsetHeight);
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
