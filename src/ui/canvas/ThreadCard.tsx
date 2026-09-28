"use client";

import { Check, RotateCcw, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { AiJobView } from "@/server/core/ai-jobs";
import type { ThreadView } from "@/server/core/threads";
import { IconButton } from "@/ui/common/Button";
import { Avatar, Spark } from "@/ui/common/MemberBadge";
import { relativeTime } from "@/ui/common/relative-time";
import { MentionTextarea, SendButton } from "./Composer";
import { FloatingPanel } from "./FloatingPanel";
import type { Point, Size } from "./geometry";

export type ThreadActions = {
  reply: (threadId: string, text: string) => Promise<void>;
  setClosed: (threadId: string, close: boolean) => Promise<void>;
  deleteMessage: (threadId: string, messageId: string, isOpening: boolean) => Promise<void>;
};

/** The popover for one thread: excerpt, messages (plain text), reply, resolve and delete. */
export function ThreadCard({
  thread,
  number,
  anchor,
  box,
  writable,
  actions,
  onClose,
}: {
  thread: ThreadView;
  number: number;
  anchor: Point | null;
  box: Size;
  writable: boolean; // newest version
  actions: ThreadActions;
  onClose: () => void;
}) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closed = thread.closedAt !== null;

  // Move focus into the popover when it opens, so Esc and Tab work from the keyboard.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when a different thread opens in the same card
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, [thread.id]);

  async function run(action: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitReply(event?: FormEvent) {
    event?.preventDefault();
    const text = reply;
    if (busy || !text.trim()) return;
    setReply("");
    const ok = await run(() => actions.reply(thread.id, text));
    if (!ok) setReply(text);
  }

  function onReplyKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submitReply();
    }
  }

  function remove(messageId: string, isOpening: boolean) {
    if (isOpening && !window.confirm("Deleting the first message deletes the whole thread. Continue?")) return;
    void run(() => actions.deleteMessage(thread.id, messageId, isOpening));
  }

  const now = Date.now();
  return (
    <FloatingPanel anchor={anchor} box={box} label={`Thread ${number}`}>
      <header className="flex items-center gap-2 border-b border-line py-2 pr-2 pl-3.5">
        <span
          className={
            "flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-semibold tabular-nums text-white " +
            (closed ? "bg-[#8b8a84]" : "bg-marker")
          }
        >
          {number}
        </span>
        <span className="text-[13px] font-medium text-soft">{closed ? "Resolved" : "Open"}</span>
        {thread.carried ? <Chip>from v{thread.openedOnNumber}</Chip> : null}
        {thread.claudeRequestedAt ? <ClaudeChip job={thread.aiJob} linked /> : null}
        <span className="flex-1" />
        {writable && thread.canClose ? (
          <IconButton
            label={closed ? "Reopen thread" : "Resolve thread"}
            disabled={busy}
            onClick={() => void run(() => actions.setClosed(thread.id, !closed))}
            className={closed ? "" : "hover:text-success"}
          >
            {closed ? <RotateCcw /> : <Check />}
          </IconButton>
        ) : null}
        <IconButton ref={closeRef} label="Close" onClick={onClose}>
          <X />
        </IconButton>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3.5 py-3.5">
        {thread.excerpt ? (
          <blockquote className="border-l-2 border-marker/60 pl-2.5 text-[13px] leading-snug whitespace-pre-wrap text-soft">
            {thread.excerpt}
          </blockquote>
        ) : null}
        <ol className="flex flex-col gap-4">
          {thread.messages.map((m) => (
            <li key={m.id} className="group flex gap-2.5">
              <Avatar name={m.senderName} size={24} assistant={m.authorKind === "assistant"} />
              <div className="min-w-0 flex-1">
                <div className="flex h-6 items-center gap-2 text-[13px]">
                  <span className="truncate font-medium text-ink">
                    {m.senderName}
                    {m.via ? <span className="font-normal text-muted"> · via {m.via}</span> : null}
                  </span>
                  <time dateTime={m.createdAt} title={new Date(m.createdAt).toLocaleString()} className="shrink-0 text-xs text-muted">
                    {relativeTime(m.createdAt, now)}
                  </time>
                  <span className="flex-1" />
                  {writable && m.canDelete ? (
                    <button
                      type="button"
                      aria-label={m.seq === 1 ? "Delete thread" : "Delete message"}
                      title={m.seq === 1 ? "Delete thread" : "Delete message"}
                      disabled={busy}
                      onClick={() => remove(m.id, m.seq === 1)}
                      className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100 disabled:opacity-40"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  ) : null}
                </div>
                {/* Untrusted text: rendered as a React text node, never as HTML. */}
                <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-ink [overflow-wrap:anywhere]">
                  <MessageText text={m.text} />
                </p>
              </div>
            </li>
          ))}
          {thread.aiJob?.status === "pending" || thread.aiJob?.status === "processing" ? (
            <ClaudeWorking queued={thread.aiJob.status === "pending"} via={thread.messages[0]?.senderName ?? null} />
          ) : null}
        </ol>
      </div>

      {error ? (
        <p role="alert" className="px-3.5 pb-2 text-xs text-danger">
          {error}
        </p>
      ) : null}

      {writable && !closed ? (
        <form onSubmit={submitReply} className="flex items-end gap-2 border-t border-line px-3.5 py-2.5">
          <div className="min-w-0 flex-1 py-0.5">
            <MentionTextarea value={reply} onChange={setReply} onKeyDown={onReplyKey} label="Reply" placeholder="Reply…" rows={1} />
          </div>
          <SendButton disabled={busy || !reply.trim()} busy={busy} label="Send reply" />
        </form>
      ) : !writable ? (
        <p className="border-t border-line px-3.5 py-2.5 text-xs text-muted">Read-only on earlier versions.</p>
      ) : null}
    </FloatingPanel>
  );
}

/** Highlights a leading "@Claude" in a message without ever interpreting the text as HTML. */
export function MessageText({ text }: { text: string }) {
  const m = /^(\s*)(@claude)\b/i.exec(text);
  if (!m) return <>{text}</>;
  return (
    <>
      {m[1]}
      <span className="rounded-[5px] bg-marker/15 px-1 font-medium text-marker">{m[2]}</span>
      {text.slice(m[0].length)}
    </>
  );
}

/** Claude's place in the conversation while it works: its avatar, name and animated dots. */
function ClaudeWorking({ queued, via }: { queued: boolean; via: string | null }) {
  return (
    <li className="flex gap-2.5">
      <Avatar name="Claude" size={24} assistant />
      <div className="min-w-0 flex-1">
        <div className="flex h-6 items-center gap-2 text-[13px]">
          <span className="truncate font-medium text-ink">
            Claude{via ? <span className="font-normal text-muted"> · via {via}</span> : null}
          </span>
          <span className="shrink-0 text-xs text-muted">now</span>
        </div>
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <span aria-hidden="true" className="dp-dots inline-flex gap-[3px] text-accent">
            <span className="size-1.5 rounded-full bg-current" />
            <span className="size-1.5 rounded-full bg-current" />
            <span className="size-1.5 rounded-full bg-current" />
          </span>
          {queued ? "Queued…" : "Working…"}
        </p>
      </div>
    </li>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-hover px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-muted">{children}</span>
  );
}

/**
 * Where a thread's "@Claude" request stands. A failure shows its reason on hover. With
 * `linked`, a finished edit links to the version Claude made (not inside another button).
 */
export function ClaudeChip({ job, linked = false }: { job: AiJobView | null; linked?: boolean }) {
  const failed = job?.status === "failed";
  const label =
    job?.status === "processing"
      ? "Claude is editing…"
      : job?.status === "completed"
        ? job.resultVersionNumber
          ? `Claude made v${job.resultVersionNumber}`
          : "Claude replied"
        : failed
          ? "Claude couldn't do this"
          : "Sent to Claude";
  const made = job?.status === "completed" ? job.resultVersionNumber : null;
  if (linked && made) {
    return (
      <Link
        href={{ query: { n: made } }}
        className="inline-flex items-center gap-1 rounded-md bg-accent/12 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-accent underline-offset-2 hover:underline"
      >
        <Spark size={9} />
        {label}
      </Link>
    );
  }
  return (
    <span
      title={failed ? (job.error ?? undefined) : undefined}
      className={
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap " +
        (failed ? "bg-danger/12 text-danger" : "bg-accent/12 text-accent")
      }
    >
      <Spark size={9} />
      {label}
    </span>
  );
}
