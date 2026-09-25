import type { Metadata } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import type { ReactNode } from "react";
import { devAuthEnabled } from "@/server/auth/dev-auth";
import "./theme.css";

// Self-hosted at build time by next/font; no request to Google at runtime.
const sans = Inter({ subsets: ["latin"], variable: "--font-dp-sans", display: "swap" });
const serif = Source_Serif_4({ subsets: ["latin"], variable: "--font-dp-serif", display: "swap" });

export const metadata: Metadata = {
  title: { default: "DraftPage", template: "%s · DraftPage" },
  description: "Review HTML pages with pinned comments and AI-assisted edits.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body className="min-h-dvh font-sans text-[15px] antialiased">
        {children}
        {devAuthEnabled() ? (
          <div
            role="status"
            title="DRAFTPAGE_DEV_AUTH=on in .env.local. Remove it to use Auth0."
            className="pointer-events-none fixed bottom-3 left-3 z-50 rounded-full border border-line-strong bg-raised px-3 py-1 text-xs font-medium text-muted shadow-[var(--shadow-pop)]"
          >
            <span className="mr-1.5 inline-block size-1.5 -translate-y-px rounded-full bg-accent align-middle" />
            Dev sign-in · Auth0 off
          </div>
        ) : null}
      </body>
    </html>
  );
}
