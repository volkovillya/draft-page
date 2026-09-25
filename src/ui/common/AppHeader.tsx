import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { Logo } from "./Logo";
import { Avatar } from "./MemberBadge";

/** Top bar for signed-in pages: logo, optional actions, member and sign-out. */
export function AppHeader({ memberName, children }: { memberName: string; children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Logo />
        <div className="ml-auto flex items-center gap-2">
          {children}
          <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
          <span className="flex items-center gap-2 text-sm text-soft" title={memberName}>
            <Avatar name={memberName} size={26} />
            <span className="hidden max-w-36 truncate sm:inline">{memberName}</span>
          </span>
          {/* Full navigation: /auth/* is handled by the proxy, not the router. */}
          <a
            href="/auth/logout"
            aria-label="Sign out"
            title="Sign out"
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink [&_svg]:size-[17px]"
          >
            <LogOut />
          </a>
        </div>
      </div>
    </header>
  );
}
