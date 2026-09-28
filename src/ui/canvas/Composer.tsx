"use client";

import { ArrowUp, X } from "lucide-react";
import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { FloatingPanel } from "./FloatingPanel";
import { splitMention, type Point, type Size } from "./geometry";

const MAX_MESSAGE = 10_000;
const MENTION = "@Claude";
const FIELD =
  "block w-full whitespace-pre-wrap break-words px-0 py-0 font-sans text-sm leading-6 [overflow-wrap:anywhere]";

/** Adds or removes the leading "@Claude " so the checkbox and the text never disagree. */
export function withClaude(text: string, on: boolean): string {
  const mention = splitMention(text);
  if (on) return mention ? text : `${MENTION} ${text.replace(/^\s+/, "")}`;
  return mention ? (mention.lead + mention.rest).replace(/^\s+/, "") : text;
}

/**
 * A borderless textarea with a styled mirror underneath it. The mirror paints a chip behind a
 * leading "@Claude"; the transparent textarea stays the real, accessible input.
 */
export function MentionTextarea({
  value,
  onChange,
  onKeyDown,
  placeholder,
  label,
  autoFocus,
  rows = 2,
  describedBy,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  label: string;
  autoFocus?: boolean;
  rows?: number;
  describedBy?: string;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const mention = splitMention(value);
  return (
    <div className="relative">
      <div
        ref={mirrorRef}
        aria-hidden="true"
        className={`${FIELD} pointer-events-none absolute inset-0 overflow-hidden text-transparent`}
      >
        {mention ? (
          <>
            {mention.lead}
            <span className="rounded-[5px] bg-marker/18 shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-marker)_18%,transparent)]">
              {mention.mention}
            </span>
            {mention.rest}
          </>
        ) : (
          value
        )}
        {"​"}
      </div>
      <textarea
        aria-label={label}
        aria-describedby={describedBy}
        value={value}
        rows={rows}
        maxLength={MAX_MESSAGE}
        // biome-ignore lint/a11y/noAutofocus: opt-in; the composer opens because the person just asked to write
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        className={`${FIELD} relative max-h-48 resize-none bg-transparent text-ink caret-ink outline-none placeholder:text-muted [field-sizing:content]`}
      />
    </div>
  );
}

/** Round send button used by the composer and replies. */
export function SendButton({ disabled, busy, label }: { disabled: boolean; busy: boolean; label: string }) {
  return (
    <button
      type="submit"
      aria-label={label}
      title={`${label} (Enter)`}
      disabled={disabled}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-opacity hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-marker disabled:bg-hover disabled:text-muted"
    >
      <ArrowUp className={"size-4 " + (busy ? "animate-pulse" : "")} strokeWidth={2.4} />
    </button>
  );
}

/** A short description of where the comment is pinned: page › element or quoted text. */
function contextLine(context: string, excerpt: string | null, target: string | null): string {
  if (excerpt) return `${context} › text “${excerpt.length > 48 ? excerpt.slice(0, 47) + "…" : excerpt}”`;
  const tag = target?.split(">").pop()?.trim().replace(/:nth-of-type\(\d+\)/g, "");
  return tag ? `${context} › ${tag}` : context;
}

/** Starts a new thread at the picked spot. Enter posts, Shift+Enter adds a line, Esc cancels. */
export function Composer({
  anchor,
  box,
  excerpt,
  target,
  context,
  onSubmit,
  onCancel,
  onDirtyChange,
}: {
  anchor: Point | null;
  box: Size;
  excerpt: string | null;
  target: string | null;
  context: string;
  onSubmit: (text: string) => Promise<void>;
  onCancel: () => void;
  /** Tells the canvas whether there's unsent text, so a stray click never discards it. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [text, setTextState] = useState("");
  const setText = (next: string | ((t: string) => string)) =>
    setTextState((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      onDirtyChange?.((splitMention(value)?.rest ?? value).trim().length > 0);
      return value;
    });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  const asksClaude = splitMention(text) !== null;
  const empty = !(splitMention(text)?.rest ?? text).trim();

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy || empty) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  }

  return (
    <FloatingPanel anchor={anchor} box={box} label="New comment" placement={excerpt ? "below" : "side"}>
      <form onSubmit={submit} className="flex flex-col">
        <div className="flex items-center gap-2 pt-2 pr-1.5 pl-3.5">
          <p className="min-w-0 flex-1 truncate text-xs text-muted">{contextLine(context, excerpt, target)}</p>
          <button
            type="button"
            aria-label="Discard comment"
            title="Discard (Esc)"
            onClick={onCancel}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-marker"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="px-3.5 pt-0.5 pb-1">
          <MentionTextarea
            value={text}
            onChange={setText}
            onKeyDown={onKeyDown}
            label="Comment"
            placeholder={asksClaude ? "Describe the change…" : "Add a comment…"}
            autoFocus
            rows={1}
            describedBy={hintId}
          />
        </div>
        {error ? (
          <p role="alert" className="px-3.5 pb-1 text-xs text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-2 px-3 pt-1 pb-2.5">
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-0.5 text-xs text-soft select-none hover:text-ink">
            <input
              type="checkbox"
              checked={asksClaude}
              onChange={(e) => setText((t) => withClaude(t, e.target.checked))}
              className="size-3.5 cursor-pointer rounded accent-[var(--color-marker)]"
            />
            Send to Claude
          </label>
          <span id={hintId} className="sr-only">
            {asksClaude ? "Claude will draft this edit as a new version for review." : "Enter to post, Shift+Enter for a new line."}
          </span>
          <span className="flex-1" />
          <SendButton disabled={busy || empty} busy={busy} label="Post comment" />
        </div>
      </form>
    </FloatingPanel>
  );
}
