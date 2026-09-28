"use client";

import { useCallback, useMemo } from "react";
import { clusterMarkers, type Cluster, type MarkerItem } from "./geometry";
import { usePlaces, type PlacesStore } from "./hooks";
import { Marker } from "./Marker";

export type MarkerThread = { id: string; number: number; closed: boolean };

/**
 * The overlay above the iframe. It follows the positions the frame reports, hides markers
 * whose target isn't visible (e.g. another slide), and merges markers within 24px.
 */
export function MarkerLayer({
  threads,
  store,
  selectedId,
  onSelect,
}: {
  threads: MarkerThread[]; // oldest first
  store: PlacesStore;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const places = usePlaces(store);

  const clusters = useMemo(() => {
    const items: MarkerItem[] = [];
    for (const t of threads) {
      const p = places.get(t.id);
      if (p?.visible) items.push({ id: t.id, number: t.number, closed: t.closed, x: p.x, y: p.y });
    }
    return clusterMarkers(items);
  }, [threads, places]);

  // A cluster selects its first open thread, then cycles through the rest on each click.
  const onActivate = useCallback(
    (cluster: Cluster) => {
      const ids = cluster.items.map((i) => i.id);
      const at = selectedId ? ids.indexOf(selectedId) : -1;
      if (at >= 0) {
        onSelect(ids[(at + 1) % ids.length]!);
        return;
      }
      const firstOpen = cluster.items.find((i) => !i.closed) ?? cluster.items[0]!;
      onSelect(firstOpen.id);
    },
    [selectedId, onSelect],
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of marker buttons on the canvas, not a form <fieldset>
    <div className="pointer-events-none absolute inset-0 overflow-hidden" role="group" aria-label="Comment markers">
      {clusters.map((c) => (
        <Marker key={c.key} cluster={c} selectedId={selectedId} onActivate={onActivate} />
      ))}
    </div>
  );
}
