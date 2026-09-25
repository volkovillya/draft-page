import Link from "next/link";

export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--color-accent)" />
      <path
        d="M10 8h8.5a5.5 5.5 0 0 1 5.5 5.5v5a5.5 5.5 0 0 1-5.5 5.5H10z"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <circle cx="21.5" cy="21.5" r="4.5" fill="var(--color-marker)" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

export function Logo({ href = "/pages" }: { href?: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-marker"
    >
      <LogoMark />
      <span className="font-serif text-[19px] font-semibold tracking-tight text-ink">DraftPage</span>
    </Link>
  );
}
