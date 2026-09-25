import type { Metadata } from "next";
import { FileQuestion } from "lucide-react";
import { buttonClass } from "@/ui/common/Button";
import { LogoMark } from "@/ui/common/Logo";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-16">
      <div className="w-full max-w-md rounded-2xl bg-panel p-8 shadow-[var(--shadow-pop)]">
        <div className="flex items-center gap-2">
          <LogoMark />
          <span className="font-serif text-lg font-semibold">DraftPage</span>
        </div>
        <div className="mt-8 flex size-10 items-center justify-center rounded-full bg-hover text-soft">
          <FileQuestion className="size-5" />
        </div>
        <h1 className="mt-4 font-serif text-[26px] leading-tight font-medium">This page doesn&apos;t exist</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-soft">
          The link may be mistyped, or the page was deleted by its owner.
        </p>
        {/* A plain link: works whether or not the visitor is signed in. */}
        <a href="/pages" className={buttonClass("inverse", "mt-7 w-full", "lg")}>
          Back to pages
        </a>
      </div>
    </main>
  );
}
