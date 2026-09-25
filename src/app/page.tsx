import { connection } from "next/server";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/session";
import { LogoMark } from "@/ui/common/Logo";
import { Avatar } from "@/ui/common/MemberBadge";

const LOGIN_HREF = "/auth/login?connection=google-oauth2&returnTo=/pages";

export default async function Home() {
  // Request-time only: the answer depends on the session cookie.
  await connection();
  if (await getSessionUser()) redirect("/pages");

  return (
    <main className="relative flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center gap-2 px-6 py-5">
        <LogoMark />
        <span className="font-serif text-[19px] font-semibold tracking-tight">DraftPage</span>
      </header>

      <div className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-14 px-6 pb-16 lg:grid-cols-[1.05fr_1fr]">
        <section>
          <h1 className="font-serif text-[44px] leading-[1.06] font-medium tracking-[-0.02em] text-balance text-ink sm:text-[58px]">
            Review web pages <span className="text-accent italic">together.</span>
          </h1>
          <p className="mt-6 max-w-md text-[17px] leading-relaxed text-soft">
            Upload a page, pin comments exactly where you mean, and keep the conversation attached as
            new versions land. Ask Claude for an edit and review it as a draft. A person always
            decides what goes live.
          </p>
          <div className="mt-9 flex flex-col items-start gap-3">
            {/* Full navigation: /auth/* is served by the proxy. */}
            <a
              href={LOGIN_HREF}
              className="inline-flex h-11 items-center gap-3 rounded-xl bg-inverse pr-5 pl-4 text-[15px] font-medium text-inverse-ink shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-marker"
            >
              <GoogleG />
              Continue with Google
            </a>
            <p className="text-[13px] text-muted">Invite-only. Access is managed by the workspace owner.</p>
          </div>
        </section>

        <ReviewIllustration />
      </div>
    </main>
  );
}

/** A static, decorative preview of the review canvas. */
function ReviewIllustration() {
  return (
    <div aria-hidden="true" className="relative hidden select-none lg:block">
      <div className="overflow-hidden rounded-2xl bg-panel shadow-[var(--shadow-pop)]">
        <div className="flex h-10 items-center gap-2 border-b border-line px-4">
          <span className="text-[13px] font-medium text-ink">Launch page</span>
          <span className="rounded-md bg-hover px-1.5 py-0.5 text-[11px] text-muted">v3 · Draft</span>
          <span className="ml-auto rounded-md bg-inverse px-2.5 py-1 text-[11px] font-medium text-inverse-ink">Publish</span>
        </div>
        <div className="relative bg-white px-10 py-9 text-[#1f1e1d]">
          <div className="h-2 w-16 rounded-full bg-[#c96442]/70" />
          <div className="mt-5 h-5 w-4/5 rounded bg-[#1f1e1d]/85" />
          <div className="mt-2.5 h-5 w-3/5 rounded bg-[#1f1e1d]/85" />
          <div className="mt-6 space-y-2">
            <div className="h-2.5 w-full rounded bg-[#1f1e1d]/12" />
            <div className="h-2.5 w-11/12 rounded bg-[#1f1e1d]/12" />
            <div className="h-2.5 w-4/6 rounded bg-[#1f1e1d]/12" />
          </div>
          <div className="mt-7 flex gap-3">
            <div className="h-9 w-32 rounded-lg bg-[#1f1e1d]" />
            <div className="h-9 w-28 rounded-lg border border-[#1f1e1d]/20" />
          </div>
          <div className="mt-8 grid grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 rounded-lg bg-[#1f1e1d]/[0.05]" />
            ))}
          </div>
          <MarkerDot n={1} className="top-[92px] left-[62%]" />
          <MarkerDot n={2} className="top-[196px] left-[150px]" />
        </div>
      </div>

      <div className="absolute top-[118px] right-[-18px] w-[264px] rounded-xl bg-raised p-3 shadow-[var(--shadow-pop)]">
        <p className="text-[11px] text-muted">Launch page › heading</p>
        <div className="mt-2 flex items-start gap-2">
          <Avatar name="Maya" size={22} />
          <p className="text-[13px] leading-snug text-ink">
            <span className="rounded bg-marker/15 px-1 font-medium text-marker">@Claude</span> make the headline
            shorter and punchier
          </p>
        </div>
        <div className="mt-3 flex items-start gap-2 border-t border-line pt-3">
          <Avatar name="Claude" size={22} assistant />
          <p className="text-[13px] leading-snug text-soft">Drafted v4 with a tighter headline. Review it before publishing.</p>
        </div>
      </div>
    </div>
  );
}

function MarkerDot({ n, className }: { n: number; className: string }) {
  return (
    <span
      className={`absolute flex size-6 items-center justify-center rounded-full bg-marker text-[11px] font-semibold text-white shadow-md ring-2 ring-white ${className}`}
    >
      {n}
    </span>
  );
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
