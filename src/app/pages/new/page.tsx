import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { AppHeader } from "@/ui/common/AppHeader";
import { requireMemberPage } from "@/ui/common/require-member-page";
import { PageUploader } from "@/ui/pages/PageUploader";

export const metadata: Metadata = { title: "New page" };

export default async function NewPage() {
  const actor = await requireMemberPage();
  return (
    <>
      <AppHeader memberName={actor.name} />
      <main className="mx-auto max-w-2xl px-4 pt-8 pb-20 sm:px-6">
        <Link href="/pages" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">
          <ChevronLeft className="size-4" />
          Pages
        </Link>
        <h1 className="mt-4 font-serif text-[32px] font-medium tracking-[-0.01em]">New page</h1>
        <p className="mt-1.5 text-[15px] text-soft">
          Upload one self-contained HTML file. It becomes version 1, as a draft only you can publish.
        </p>
        <div className="mt-8 rounded-2xl bg-panel p-6 ring-1 ring-line">
          <PageUploader />
        </div>
      </main>
    </>
  );
}
