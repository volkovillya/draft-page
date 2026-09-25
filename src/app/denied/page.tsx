import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { LogoMark } from "@/ui/common/Logo";
import { buttonClass } from "@/ui/common/Button";

export const metadata: Metadata = { title: "No access" };

export default async function DeniedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { reason } = await searchParams;
  const detail = typeof reason === "string" ? reason.slice(0, 300) : null;

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-16">
      <div className="w-full max-w-md rounded-2xl bg-panel p-8 shadow-[var(--shadow-pop)]">
        <div className="flex items-center gap-2">
          <LogoMark />
          <span className="font-serif text-lg font-semibold">DraftPage</span>
        </div>
        <div className="mt-8 flex size-10 items-center justify-center rounded-full bg-accent/12 text-accent">
          <ShieldAlert className="size-5" />
        </div>
        <h1 className="mt-4 font-serif text-[26px] leading-tight font-medium">This account doesn&apos;t have access</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-soft">
          DraftPage is invite-only, and this Google account isn&apos;t on the access list. Sign out and try another
          account, or ask the workspace owner to add you.
        </p>
        {detail ? (
          <p className="mt-5 rounded-lg bg-hover px-3 py-2 font-mono text-xs text-muted">{detail}</p>
        ) : null}
        <a href="/auth/logout" className={buttonClass("inverse", "mt-7 w-full", "lg")}>
          Sign out and try again
        </a>
      </div>
    </main>
  );
}
