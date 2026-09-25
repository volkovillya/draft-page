"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import type { BridgeAnchor } from "@/frame-bridge/bridge";
import type { PageDetail, VersionSummary } from "@/server/core/pages";
import type { MessageView, ThreadView } from "@/server/core/threads";
import {
  ChevronDown,
  ChevronLeft,
  Download,
  FileText,
  History,
  MessageSquarePlus,
  MessagesSquare,
  Plus,
  Rocket,
  RotateCcw,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { Button, IconButton, iconLinkClass } from "@/ui/common/Button";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/ui/common/Menu";
import { Spark } from "@/ui/common/MemberBadge";
import { useRefreshOnHistoryReturn } from "@/ui/common/refresh-on-return";
import { AddVersionDialog } from "./AddVersionDialog";
import { api, fetchThreads } from "./api";
import { Composer } from "./Composer";
import type { Size } from "./geometry";
import { createPlacesStore, isTypingTarget, useElementSize, usePlace, type PlacesStore } from "./hooks";
import { MarkerLayer, type MarkerThread } from "./MarkerLayer";
import { readFrameMessage, type FrameMessage, type FramePick, type ParentMessage } from "./protocol";
import { ThreadCard, type ThreadActions } from "./ThreadCard";
import { ThreadRail, type RailThread } from "./ThreadRail";

export type CanvasPage = Pick<PageDetail, "shortId" | "title" | "ownerName" | "isOwner" | "versions">;

/** Pseudo thread id for the composer's pick point, so it follows the page like a marker. */
const DRAFT_ID = "draft";
const AI_POLL_MS = 2000;

/**
 * The review canvas: the version rendered in a sandboxed iframe, a marker overlay driven by
 * the frame bridge, a thread popover or composer, and the thread rail.
 */
export function ReviewCanvas({
  page,
  version,
  initialThreads,
  memberName,
}: {
  page: CanvasPage;
  version: VersionSummary;
  initialThreads: ThreadView[];
  memberName: string;
}) {
  const router = useRouter();
  const newest = page.versions[0]!;
  const writable = version.id === newest.id; // only the newest version takes comments
  const shortId = page.shortId;

  const [threads, setThreads] = useState(initialThreads);
  // A router.refresh() (e.g. coming back through browser history) brings fresh server data.
  const [seenInitial, setSeenInitial] = useState(initialThreads);
  if (seenInitial !== initialThreads) {
    setSeenInitial(initialThreads);
    setThreads(initialThreads);
  }
  const [placing, setPlacing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<FramePick | null>(null);
  const [offer, setOffer] = useState<FramePick | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [frameLost, setFrameLost] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const narrow = useNarrow();
  // The frame is pointed at the page only after this component is listening for its
  // messages; otherwise a fast frame could announce "ready" before hydration and be missed.
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, startPublish] = useTransition();
  const [store] = useState<PlacesStore>(createPlacesStore);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const loadsRef = useRef(0);
  const reloadSeq = useRef(0);
  const draftDirty = useRef(false);
  const box = useElementSize(stageRef);
  useRefreshOnHistoryReturn();

  // While Claude is working on a thread, refetch this version's threads every few seconds
  // (only while the tab is visible) so its reply and status show up without a reload. Only
  // the threads: a full refresh would jump to Claude's new version while you're reviewing.
  const aiBusy = threads.some((t) => t.aiJob?.status === "pending" || t.aiJob?.status === "processing");
  // Claude made a version the version menu doesn't list yet. Stays true until a server render
  // brings it, so a failed refresh (e.g. a 503) is simply retried on the next tick.
  const versionsBehind = threads.some(
    (t) => t.aiJob?.resultVersionNumber != null && !page.versions.some((v) => v.number === t.aiJob!.resultVersionNumber),
  );
  useEffect(() => {
    if (!aiBusy && !versionsBehind) return;
    // Re-render on the server with this version pinned in the URL, so the menu updates without
    // jumping to Claude's version (the default is "live, else newest"). One call, never both.
    const syncVersions = () => {
      const pinned = new URLSearchParams(window.location.search).get("n") === String(version.number);
      if (pinned) router.refresh();
      else router.replace(`/pages/${encodeURIComponent(shortId)}?n=${version.number}`, { scroll: false });
    };
    if (versionsBehind) syncVersions();
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (versionsBehind) return syncVersions();
      fetchThreads(shortId, version.number).then(setThreads, () => {}); // next tick retries
    }, AI_POLL_MS);
    return () => clearInterval(timer);
  }, [aiBusy, versionsBehind, shortId, version.number, router]);

  // On a phone the comments open as a sheet over the page, so start with them closed.
  useEffect(() => {
    if (narrow) setRailOpen(false);
  }, [narrow]);

  // Core lists oldest first, so a thread's number is its position (oldest = 1),
  // the same numbering the Markdown export uses.
  const ordered = threads;
  const railThreads = useMemo<RailThread[]>(() => ordered.map((thread, i) => ({ thread, number: i + 1 })), [ordered]);
  const markerThreads = useMemo<MarkerThread[]>(
    () => ordered.map((t, i) => ({ id: t.id, number: i + 1, closed: t.closedAt !== null })),
    [ordered],
  );
  const anchors = useMemo<BridgeAnchor[]>(() => {
    const list = threads.map((t) => ({ threadId: t.id, targetPath: t.targetPath, posX: t.posX, posY: t.posY }));
    if (draft) list.push({ threadId: DRAFT_ID, targetPath: draft.targetPath, posX: draft.posX, posY: draft.posY });
    return list;
  }, [threads, draft]);

  const selected = selectedId ? railThreads.find((r) => r.thread.id === selectedId) : undefined;

  // ---- Frame bridge ----------------------------------------------------------------

  const post = useCallback((message: ParentMessage) => {
    // The frame is an opaque origin, so "*" is the only usable target. After the frame
    // navigates away from our document (second load) nothing more is sent to it.
    const target = iframeRef.current?.contentWindow;
    if (target && loadsRef.current <= 1) target.postMessage(message, "*");
  }, []);

  const onFrameMessage = useEffectEvent((message: FrameMessage) => {
    switch (message.type) {
      case "ready":
        setFrameReady(true);
        post({ dp: 1, type: "mode", placing });
        post({ dp: 1, type: "locate", anchors });
        break;
      case "scroll":
        setOffer(null); // its position was a one-off viewport point
        break;
      case "places":
        store.set(message.places);
        break;
      case "pick":
        if (!writable) break;
        if (message.excerpt) {
          setOffer(message);
        } else if (placing) {
          // Only honored while the user has placing mode on; content can't open the composer alone.
          setPlacing(false);
          setSelectedId(null);
          setOffer(null);
          setDraft(message);
        }
        break;
      case "key":
        if (message.key === "Escape") escape();
        else if (writable && !addOpen) togglePlacing();
        break;
      case "tap":
        dismiss();
        break;
      case "size":
        break;
    }
  });

  /** A click elsewhere: close popovers, but never throw away a comment that has text. */
  const dismiss = useEffectEvent(() => {
    setOffer(null);
    setSelectedId(null);
    if (draft && !draftDirty.current) setDraft(null);
  });

  /** Esc: close the innermost thing that's open. */
  const escape = useEffectEvent(() => {
    if (draft) setDraft(null);
    else if (offer) setOffer(null);
    else if (selectedId) setSelectedId(null);
    else if (placing) setPlacing(false);
  });

  // Clicks on the app chrome (toolbar, panel, empty stage) count as "outside" too.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const t = event.target instanceof Element ? event.target : null;
      if (!t || t.closest("[data-dp-floating], [role=menu], dialog, [aria-label='Comment markers'] button")) return;
      dismiss();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  useEffect(() => {
    if (!draft) draftDirty.current = false;
  }, [draft]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const message = readFrameMessage(event.data);
      if (message) onFrameMessage(message);
    };
    window.addEventListener("message", onMessage);
    setFrameSrc(`/api/versions/${version.id}/frame`);
    return () => window.removeEventListener("message", onMessage);
  }, [version.id]);

  useEffect(() => {
    if (frameReady) post({ dp: 1, type: "mode", placing });
  }, [frameReady, placing, post]);

  useEffect(() => {
    if (frameReady) post({ dp: 1, type: "locate", anchors });
  }, [frameReady, anchors, post]);

  function onFrameLoad() {
    loadsRef.current += 1;
    if (loadsRef.current > 1) {
      setFrameReady(false);
      setFrameLost(true);
      store.set([]);
    }
  }

  function restoreFrame() {
    loadsRef.current = 0;
    setFrameLost(false);
    setFrameReady(false);
    setFrameKey((k) => k + 1);
  }

  // ---- Keyboard --------------------------------------------------------------------

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (addOpen) return; // the native dialog handles its own keys
    if (event.key === "Escape") {
      escape();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if ((event.key === "c" || event.key === "C") && writable && !isTypingTarget(event.target)) {
      event.preventDefault();
      togglePlacing();
    }
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  function togglePlacing() {
    setPlacing((on) => !on);
    setDraft(null);
    setOffer(null);
  }

  // ---- Data ------------------------------------------------------------------------

  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    try {
      const next = await fetchThreads(shortId, version.number);
      if (seq === reloadSeq.current) setThreads(next);
    } catch (e) {
      if (seq === reloadSeq.current) setError((e as Error).message);
    }
  }, [shortId, version.number]);

  const onSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      setDraft(null);
      setOffer(null);
      if (narrow) setRailOpen(false); // the sheet would cover the card
    },
    [narrow],
  );

  const closeCard = useCallback(() => setSelectedId(null), []);

  // Optimistic where it's trivial; every mutation ends with one reload() to reconcile.
  const actions = useMemo<ThreadActions>(() => {
    const patch = (id: string, fn: (t: ThreadView) => ThreadView | null) =>
      setThreads((list) => list.flatMap((t) => (t.id === id ? (fn(t) ?? []) : [t])));
    const mutate = async (optimistic: () => void, request: () => Promise<unknown>) => {
      optimistic();
      try {
        await request();
      } finally {
        await reload();
      }
    };
    return {
      reply: (threadId, text) =>
        mutate(
          () =>
            patch(threadId, (t) => {
              const temp: MessageView = {
                id: `pending-${t.messages.length}`,
                seq: t.messages.length + 1,
                authorKind: "member",
                senderName: memberName,
                via: null,
                text,
                createdAt: new Date().toISOString(),
                canDelete: false,
              };
              return { ...t, messages: [...t.messages, temp] };
            }),
          () => api(`/api/threads/${threadId}/messages`, { method: "POST", body: { text } }),
        ),
      setClosed: (threadId, close) =>
        mutate(
          () => patch(threadId, (t) => ({ ...t, closedAt: close ? new Date().toISOString() : null })),
          () => api(`/api/threads/${threadId}/${close ? "close" : "reopen"}`, { method: "POST" }),
        ),
      deleteMessage: (threadId, messageId, isOpening) =>
        mutate(
          () => {
            if (isOpening) setSelectedId(null);
            patch(threadId, (t) => (isOpening ? null : { ...t, messages: t.messages.filter((m) => m.id !== messageId) }));
          },
          () => api(`/api/messages/${messageId}`, { method: "DELETE" }),
        ),
    };
  }, [reload, memberName]);

  async function submitDraft(text: string) {
    if (!draft) return;
    const created = await api<{ threadId?: unknown }>(`/api/pages/${encodeURIComponent(shortId)}/threads`, {
      method: "POST",
      body: {
        versionId: version.id,
        posX: draft.posX,
        posY: draft.posY,
        targetPath: draft.targetPath ?? undefined,
        excerpt: draft.excerpt ?? undefined,
        text,
      },
    });
    setDraft(null);
    await reload();
    if (typeof created?.threadId === "string") setSelectedId(created.threadId);
  }

  function togglePublish() {
    const live = version.state === "live";
    setError(null);
    startPublish(async () => {
      try {
        await api(`/api/versions/${version.id}/${live ? "unpublish" : "publish"}`, { method: "POST" });
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  // ---- Render ----------------------------------------------------------------------

  const openCount = threads.filter((t) => t.closedAt === null).length;
  const live = version.state === "live";
  const publishLabel = live ? "Unpublish" : writable ? "Publish" : `Publish v${version.number}`;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-ink">
      <header className="flex h-12 min-w-0 shrink-0 items-center gap-1 border-b border-line bg-canvas px-2">
        <Link href="/pages" aria-label="Back to pages" title="Back to pages" className={iconLinkClass()}>
          <ChevronLeft />
        </Link>
        <PageMenu
          page={page}
          version={version}
          ownThreadCount={threads.filter((t) => !t.carried).length}
          onAddVersion={() => setAddOpen(true)}
          onError={setError}
        />
        <span
          className={
            "ml-1 hidden items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium sm:inline-flex " +
            (live ? "bg-success/12 text-success" : "bg-hover text-muted")
          }
        >
          {live ? <span className="size-1.5 rounded-full bg-success" /> : null}
          {live ? "Live" : "Draft"}
        </span>
        {version.origin === "assistant" ? (
          <span className="ml-1 hidden items-center gap-1 rounded-md bg-accent/12 px-1.5 py-0.5 text-xs font-medium text-accent sm:inline-flex">
            <Spark size={10} /> By Claude
          </span>
        ) : null}

        <span className="flex-1" />

        {writable ? (
          <button
            type="button"
            aria-pressed={placing}
            aria-keyshortcuts="C"
            title="Comment (C)"
            onClick={togglePlacing}
            className={
              "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors " +
              "focus-visible:outline-2 focus-visible:outline-marker [&_svg]:size-4 " +
              (placing ? "bg-marker text-marker-ink" : "text-soft hover:bg-hover hover:text-ink")
            }
          >
            <MessageSquarePlus />
            <span className="hidden sm:inline">Comment</span>
            <kbd className={"hidden rounded px-1 font-sans text-[11px] sm:inline " + (placing ? "bg-white/20" : "bg-hover text-muted")}>C</kbd>
          </button>
        ) : null}
        <button
          type="button"
          aria-pressed={railOpen}
          aria-label={`${railOpen ? "Hide" : "Show"} comments, ${openCount} open`}
          title={railOpen ? "Hide comments" : "Show comments"}
          onClick={() => setRailOpen((o) => !o)}
          className="relative inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-soft transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-marker aria-pressed:bg-hover aria-pressed:text-ink [&_svg]:size-4"
        >
          <MessagesSquare />
          <span className="tabular-nums">{openCount}</span>
        </button>
        {page.isOwner ? (
          <Button
            variant={live ? "secondary" : "inverse"}
            size="sm"
            onClick={togglePublish}
            disabled={publishing}
            aria-label={publishing ? "Saving…" : publishLabel}
            title={writable || live ? undefined : `Make v${version.number} the live version`}
            className="ml-1.5 max-sm:w-8 max-sm:px-0"
          >
            {live ? <Undo2 className="sm:hidden" /> : <Rocket />}
            <span className="max-sm:sr-only">{publishing ? "Saving…" : publishLabel}</span>
          </Button>
        ) : null}
      </header>

      {!writable ? (
        <Notice>
          <History className="size-4 text-muted" />
          <span className="flex-1">
            Viewing v{version.number}, an earlier version. Comments are read-only here.
          </span>
          <Link
            href={`/pages/${encodeURIComponent(shortId)}?n=${newest.number}`}
            className="font-medium text-marker hover:underline"
          >
            Open v{newest.number}
          </Link>
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="danger">
          <span className="flex-1">{error}</span>
          <IconButton label="Dismiss" onClick={() => setError(null)} className="size-6">
            <X />
          </IconButton>
        </Notice>
      ) : null}
      {frameLost ? (
        <Notice>
          <span className="flex-1">The page navigated inside the preview, so comments are paused.</span>
          <Button size="sm" onClick={restoreFrame}>
            <RotateCcw />
            Reload preview
          </Button>
        </Notice>
      ) : null}

      <div className="relative flex min-h-0 flex-1">
        <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-white">
          {frameSrc ? (
          <iframe
            key={frameKey}
            ref={iframeRef}
            src={frameSrc}
            // Scripts only. Never allow-same-origin: the page must stay in an opaque origin.
            sandbox="allow-scripts"
            title={`${page.title}, version ${version.number}`}
            onLoad={onFrameLoad}
            className="absolute inset-0 h-full w-full border-0"
          />
          ) : null}
          {placing ? <div className="pointer-events-none absolute inset-0 ring-2 ring-marker ring-inset" /> : null}
          <MarkerLayer threads={markerThreads} store={store} selectedId={selectedId} onSelect={onSelect} />
          {placing ? (
            <p className="dp-pop pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-inverse px-3.5 py-1.5 text-[13px] font-medium text-inverse-ink shadow-[var(--shadow-pop)]">
              Click anywhere to comment <span className="opacity-60">· Esc to cancel</span>
            </p>
          ) : null}
          {offer && !draft ? (
            <button
              type="button"
              onClick={() => {
                setDraft(offer);
                setOffer(null);
                setSelectedId(null);
              }}
              style={{
                left: Math.min(Math.max(8, offer.clientX + 8), Math.max(8, box.w - 140)),
                top: Math.min(Math.max(8, offer.clientY + 10), Math.max(8, box.h - 44)),
              }}
              data-dp-floating=""
              className="dp-pop absolute z-20 inline-flex h-8 items-center gap-1.5 rounded-lg bg-raised px-2.5 text-[13px] font-medium text-ink shadow-[var(--shadow-pop)] hover:bg-hover focus-visible:outline-2 focus-visible:outline-marker [&_svg]:size-4 [&_svg]:text-marker"
            >
              <MessageSquarePlus />
              Comment
            </button>
          ) : null}
          {draft ? (
            <DraftComposer
              key={`${draft.clientX},${draft.clientY}`}
              draft={draft}
              store={store}
              box={box}
              context={page.title}
              onSubmit={submitDraft}
              onCancel={() => setDraft(null)}
              onDirtyChange={(dirty) => {
                draftDirty.current = dirty;
              }}
            />
          ) : selected ? (
            <SelectedCard
              key={selected.thread.id}
              entry={selected}
              store={store}
              box={box}
              writable={writable}
              actions={actions}
              onClose={closeCard}
            />
          ) : null}
        </div>
        {railOpen ? (
          <ThreadRail
            sheet={narrow}
            threads={railThreads}
            selectedId={selectedId}
            onSelect={onSelect}
            onClose={() => setRailOpen(false)}
            writable={writable}
          />
        ) : null}
      </div>

      {page.isOwner ? <AddVersionDialog shortId={shortId} open={addOpen} onClose={() => setAddOpen(false)} /> : null}
    </div>
  );
}

function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "danger" }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={
        "flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-2 text-[13px] " +
        (tone === "danger" ? "bg-danger/10 text-danger" : "bg-panel text-soft")
      }
    >
      {children}
    </div>
  );
}

/** Title button with the version list and page actions, like a document menu. */
function PageMenu({
  page,
  version,
  ownThreadCount,
  onAddVersion,
  onError,
}: {
  page: CanvasPage;
  version: VersionSummary;
  /** Threads opened on this version (not carried from earlier ones): deleted with it. */
  ownThreadCount: number;
  onAddVersion: () => void;
  onError: (message: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = (n: number) =>
    startTransition(() => router.push(`/pages/${encodeURIComponent(page.shortId)}?n=${n}`));
  const canDeleteVersion = page.isOwner && version.state !== "live" && page.versions.length > 1;
  function deleteVersion() {
    const threads =
      ownThreadCount === 0
        ? ""
        : ` and the ${ownThreadCount} comment ${ownThreadCount === 1 ? "thread" : "threads"} opened on it`;
    if (!window.confirm(`Delete version ${version.number}${threads}? It can't be undone.`)) return;
    startTransition(async () => {
      try {
        await api(`/api/versions/${version.id}`, { method: "DELETE" });
        router.replace(`/pages/${encodeURIComponent(page.shortId)}`); // back to the default version
        router.refresh();
      } catch (e) {
        onError((e as Error).message);
      }
    });
  }
  function deletePage() {
    const count = page.versions.length;
    const ok = window.confirm(
      `Delete “${page.title}”? This removes all ${count} ${count === 1 ? "version" : "versions"} and every comment. It can't be undone.`,
    );
    if (!ok) return;
    startTransition(async () => {
      try {
        await api(`/api/pages/${encodeURIComponent(page.shortId)}`, { method: "DELETE" });
        router.replace("/pages");
        router.refresh();
      } catch (e) {
        onError((e as Error).message);
      }
    });
  }
  return (
    <Menu
      label="Page menu"
      width={300}
      className="min-w-0"
      trigger={({ open, toggle, id }) => (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={toggle}
          className="inline-flex h-8 max-w-full min-w-0 items-center gap-1 rounded-lg px-2 text-sm font-medium text-ink hover:bg-hover focus-visible:outline-2 focus-visible:outline-marker aria-expanded:bg-hover"
        >
          <span className="truncate">{page.title}</span>
          <span className="shrink-0 font-normal text-muted">v{version.number}</span>
          <ChevronDown className={"size-4 shrink-0 text-muted transition-transform " + (open ? "rotate-180" : "")} />
          {pending ? <span className="sr-only">Loading version</span> : null}
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuLabel>Versions</MenuLabel>
          {page.versions.map((v, i) => (
            <MenuItem
              key={v.id}
              checked={v.number === version.number}
              icon={v.origin === "assistant" ? <Sparkles /> : <FileText />}
              hint={
                <>
                  {v.state === "live" ? <span className="text-success">Live</span> : "Draft"}
                  {i === 0 ? " · newest" : ""}
                </>
              }
              onSelect={() => {
                close();
                if (v.number !== version.number) go(v.number);
              }}
            >
              Version {v.number}
              {v.origin === "assistant" ? <span className="text-muted"> · Claude</span> : null}
            </MenuItem>
          ))}
          <MenuSeparator />
          {page.isOwner ? (
            <MenuItem
              icon={<Plus />}
              onSelect={() => {
                close();
                onAddVersion();
              }}
            >
              Upload new version…
            </MenuItem>
          ) : null}
          <MenuItem
            icon={<Download />}
            href={`/api/versions/${version.id}/review.md`}
            download={`review-${page.shortId}-v${version.number}.md`}
            onSelect={close}
          >
            Export review as Markdown
          </MenuItem>
          {canDeleteVersion ? (
            <MenuItem icon={<Trash2 />} danger onSelect={() => { close(); deleteVersion(); }}>
              Delete version {version.number}…
            </MenuItem>
          ) : null}
          {page.isOwner ? (
            <MenuItem icon={<Trash2 />} danger onSelect={() => { close(); deletePage(); }}>
              Delete page…
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <p className="px-2.5 py-1.5 text-xs text-muted">
            {page.isOwner ? "You own this page" : `Owned by ${page.ownerName}`}
          </p>
        </>
      )}
    </Menu>
  );
}

/** Subscribes to its own marker position so scrolling re-renders only the popover. */
function SelectedCard({
  entry,
  store,
  box,
  writable,
  actions,
  onClose,
}: {
  entry: RailThread;
  store: PlacesStore;
  box: Size;
  writable: boolean;
  actions: ThreadActions;
  onClose: () => void;
}) {
  const place = usePlace(store, entry.thread.id);
  return (
    <ThreadCard
      thread={entry.thread}
      number={entry.number}
      anchor={place?.visible ? { x: place.x, y: place.y } : null}
      box={box}
      writable={writable}
      actions={actions}
      onClose={onClose}
    />
  );
}

function DraftComposer({
  draft,
  store,
  box,
  context,
  onSubmit,
  onCancel,
  onDirtyChange,
}: {
  draft: FramePick;
  store: PlacesStore;
  box: Size;
  context: string;
  onSubmit: (text: string) => Promise<void>;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const place = usePlace(store, DRAFT_ID);
  const anchor = place ? (place.visible ? { x: place.x, y: place.y } : null) : { x: draft.clientX, y: draft.clientY };
  return (
    <>
      {anchor && !draft.excerpt ? (
        <span
          aria-hidden="true"
          style={{ left: anchor.x, top: anchor.y }}
          className="pointer-events-none absolute z-10 size-[26px] -translate-y-full rounded-[13px_13px_13px_3px] bg-marker ring-2 ring-white shadow-[0_0_0_5px_color-mix(in_srgb,var(--color-marker)_22%,transparent)]"
        />
      ) : null}
      <Composer
        anchor={anchor}
        box={box}
        excerpt={draft.excerpt}
        target={draft.targetPath}
        context={context}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onDirtyChange={onDirtyChange}
      />
    </>
  );
}

/** Whether the viewport is phone-sized (below Tailwind's md breakpoint). */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767.98px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}
