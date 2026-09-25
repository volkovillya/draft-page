const TONES = ["#c96442", "#2c84db", "#3f8f5b", "#8a6bd1", "#c4862b", "#d0527a"];

/** Stable color per name, so the same person always gets the same avatar. */
function toneFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length]!;
}

export function Avatar({ name, size = 24, assistant = false }: { name: string; size?: number; assistant?: boolean }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45), background: assistant ? undefined : toneFor(name) }}
      className={
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white " +
        (assistant ? "bg-accent" : "")
      }
    >
      {assistant ? <Spark size={Math.round(size * 0.6)} /> : initial}
    </span>
  );
}

/** DraftPage's own mark for assistant messages: a simple four-point spark. */
export function Spark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0.8c.4 3.6 2.9 6.2 6.9 7.2-4 1-6.5 3.6-6.9 7.2-.4-3.6-2.9-6.2-6.9-7.2 4-1 6.5-3.6 6.9-7.2z" />
    </svg>
  );
}

/** A member's avatar, plus their name. */
export function MemberBadge({ name, showName = true }: { name: string; showName?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-soft">
      <Avatar name={name} size={26} />
      {showName ? <span className="max-w-40 truncate">{name}</span> : <span className="sr-only">{name}</span>}
    </span>
  );
}
