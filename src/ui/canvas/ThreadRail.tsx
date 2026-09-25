"use client";

import { MessageSquarePlus, X } from "lucide-react";
import { memo, useState } from "react";
import type { ThreadView } from "@/server/core/threads";
import { IconButton } from "@/ui/common/Button";
import { Avatar } from "@/ui/common/MemberBadge";
import { Chip, ClaudeChip, MessageText } from "./ThreadCard";

export type RailThread = { thread: ThreadView; number: number };

/** The comments panel: open or resolved threads on this version. */
export const ThreadRail = memo(function ThreadRail({
  threads,
  selectedId,
  onSelect,
  onClose,
  writable,
  sheet = false,
}: {
  threads: RailThread[]; // oldest first
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  writable: boolean;
  /** Phone layout: a full-height sheet over the page instead of a side column. */
  sheet?: boolean;
}) {
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const open = threads.filter((t) => t.thread.closedAt === null);
  const resolved = threads.filter((t) => t.thread.closedAt !== null);
  const shown = tab === "open" ? open : resolved;

  const tabClass = (active: boolean) =>
    "h-7 rounded-md px-2.5 text-[13px] font-medium transition-colors " +
    (active ? "bg-hover text-ink" : "text-muted hover:text-ink");

  return (
    <aside
      aria-label="Comments"
      className={
        "flex shrink-0 flex-col border-l border-line bg-panel " +
        (sheet ? "dp-pop absolute inset-y-0 right-0 z-30 w-full shadow-[var(--shadow-pop)]" : "w-[340px]")
      }
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line pr-1.5 pl-3">
        <h2 className="mr-2 text-sm font-medium text-ink">Comments</h2>
        {/* Switching tabs isn't "clicking outside", so it keeps the open thread card. */}
        <div role="tablist" aria-label="Filter" className="flex gap-0.5" data-dp-floating="">
          <button type="button" role="tab" aria-selected={tab === "open"} className={tabClass(tab === "open")} onClick={() => setTab("open")}>
            Open <span className="text-muted tabular-nums">{open.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === "resolved"} className={tabClass(tab === "resolved")} onClick={() => setTab("resolved")}>
            Resolved <span className="text-muted tabular-nums">{resolved.length}</span>
          </button>
        </div>
        <span className="flex-1" />
        <IconButton label="Hide comments" onClick={onClose}>
          <X />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {shown.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-hover text-muted">
              <MessageSquarePlus className="size-[18px]" />
            </span>
            <p className="mt-3 text-sm font-medium text-ink">{tab === "open" ? "No open comments" : "Nothing resolved yet"}</p>
            {tab === "open" && writable ? (
              <p className="mt-1 text-[13px] leading-relaxed text-muted">
                Press <kbd className="rounded bg-hover px-1 font-sans text-xs text-soft">C</kbd> and click the page, or
                select text to comment on it.
              </p>
            ) : null}
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {shown.map(({ thread, number }) => {
              const first = thread.messages[0];
              const selected = thread.id === selectedId;
              const replies = Math.max(0, thread.messages.length - 1);
              const closed = thread.closedAt !== null;
              return (
                <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(thread.id)}
                    aria-current={selected ? "true" : undefined}
                    className={
                      "flex w-full gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-marker " +
                      (selected ? "bg-hover" : "")
                    }
                  >
                    <span
                      aria-hidden="true"
                      className={
                        "mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[11px] font-semibold text-white tabular-nums " +
                        (closed ? "bg-[#8b8a84]" : "bg-marker")
                      }
                    >
                      {number}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="sr-only">Thread {number}. </span>
                      <span className="flex items-center gap-1.5 text-[13px]">
                        <Avatar name={first?.senderName ?? "?"} size={16} />
                        <span className="truncate font-medium text-ink">{first?.senderName ?? "Unknown"}</span>
                        {replies > 0 ? (
                          <span className="shrink-0 text-muted">
                            · {replies} {replies === 1 ? "reply" : "replies"}
                          </span>
                        ) : null}
                      </span>
                      {thread.excerpt ? (
                        <span className="line-clamp-1 border-l-2 border-line-strong pl-2 text-xs text-muted">{thread.excerpt}</span>
                      ) : null}
                      <span className="line-clamp-2 text-sm leading-snug text-soft">
                        <MessageText text={first?.text ?? ""} />
                      </span>
                      {thread.carried || thread.claudeRequestedAt ? (
                        <span className="mt-0.5 flex flex-wrap gap-1">
                          {thread.carried ? <Chip>from v{thread.openedOnNumber}</Chip> : null}
                          {thread.claudeRequestedAt ? <ClaudeChip /> : null}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
});
