/**
 * The frame bridge: a script injected into every served version so the review canvas
 * (the parent window) can place and follow markers without touching the page's DOM.
 *
 * `frameBridge` is serialized with `Function.prototype.toString()` and runs inside the
 * sandboxed iframe (opaque origin). It must stay SELF-CONTAINED: no imports, no references
 * to anything at module scope, no `</script` sequence in its source. Everything it needs is
 * declared inside it. Called with `install = false` (tests only) it just returns its pure
 * helpers without registering listeners or posting messages.
 *
 * Protocol (spec §6), every message is `{ dp: 1, type, ... }`:
 *   frame → parent: ready {docW, docH} · size {docW, docH} · scroll {x, y}
 *                   · pick {posX, posY, targetPath, excerpt?, clientX, clientY}
 *                   · places {places: [{threadId, x, y, visible}]}
 *   frame → parent also: key {key: "Escape" | "c"} · tap {} (forwarded so the canvas works while focus is in the frame)
 *   parent → frame: mode {placing} · locate {anchors: [{threadId, targetPath, posX, posY}]}
 */

export type BridgeAnchor = { threadId: string; targetPath: string | null; posX: number; posY: number };
export type BridgePlace = { threadId: string; x: number; y: number; visible: boolean };

export type BridgeHelpers = {
  MAX_PATH: number;
  /** Stored positions are clamped to POS_MIN..POS_MAX (mirrors src/frame-bridge/range.ts). */
  POS_MIN: number;
  POS_MAX: number;
  MAX_EXCERPT: number;
  /** CSS path from `body` to `el` (or to the deepest ancestor whose path fits in MAX_PATH). */
  cssPath: (el: Element) => { path: string | null; element: Element | null };
  /** Whether an element renders: not display:none / visibility:hidden, opacity ≥ 0.05, non-zero box. */
  isVisible: (el: Element) => boolean;
  /**
   * Anchor for a viewport point on `el`: its path plus the point as a fraction of the box.
   * A point on empty space (`el` is body/html) attaches to the nearest visible element instead.
   */
  anchorFor: (el: Element | null, clientX: number, clientY: number) => {
    targetPath: string | null;
    posX: number;
    posY: number;
  };
  /** Stored anchor → viewport point in this frame. */
  resolve: (anchor: BridgeAnchor) => BridgePlace;
  /** Tags a payload for the parent. */
  tag: <T extends object>(type: string, payload: T) => T & { dp: 1; type: string };
};

export function frameBridge(install = true): BridgeHelpers {
  const MAX_PATH = 512;
  const MAX_EXCERPT = 500;
  const MAX_ANCHORS = 2000;
  const MIN_OPACITY = 0.05;
  const POS_MIN = -1;
  const POS_MAX = 2;
  const MAX_SCAN = 4000; // elements considered when looking for the nearest one
  const SKIP_TAGS = /^(script|style|template|noscript|link|meta|head|title|br|wbr)$/;
  const doc = document;
  const win = window;

  function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  function clampPos(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return n < POS_MIN ? POS_MIN : n > POS_MAX ? POS_MAX : n;
  }

  function escapeIdent(name: string): string {
    const css = (win as { CSS?: { escape?: (s: string) => string } }).CSS;
    if (css && typeof css.escape === "function") return css.escape(name);
    return name.replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  }

  function cssPath(el: Element): { path: string | null; element: Element | null } {
    const body = doc.body;
    const chain: { el: Element; seg: string }[] = [];
    let node: Element | null = el;
    while (node && node !== body && node !== doc.documentElement) {
      const parent: Element | null = node.parentElement;
      if (!parent) return { path: null, element: null }; // detached or outside body
      const name = node.localName;
      let index = 1;
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.localName === name) index++;
      }
      chain.unshift({ el: node, seg: escapeIdent(name) + ":nth-of-type(" + index + ")" });
      node = parent;
    }
    if (node !== body || chain.length === 0) return { path: null, element: null };
    // Too long: anchor to the deepest ancestor whose path still fits.
    let path = "body > " + chain.map((c) => c.seg).join(" > ");
    while (path.length > MAX_PATH && chain.length > 0) {
      chain.pop();
      path = "body > " + chain.map((c) => c.seg).join(" > ");
    }
    if (chain.length === 0) return { path: null, element: null };
    return { path, element: chain[chain.length - 1]!.el };
  }

  function isVisible(el: Element): boolean {
    const style = win.getComputedStyle(el);
    // visibility is inherited, so the element's own computed value is the effective one.
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
    let opacity = 1;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const s = n === el ? style : win.getComputedStyle(n);
      if (s.display === "none") return false;
      const o = parseFloat(s.opacity);
      if (Number.isFinite(o)) opacity *= o;
      if (opacity < MIN_OPACITY) return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function docBox() {
    const root = doc.documentElement;
    return {
      w: Math.max(root.scrollWidth, doc.body ? doc.body.scrollWidth : 0, 1),
      h: Math.max(root.scrollHeight, doc.body ? doc.body.scrollHeight : 0, 1),
    };
  }

  /**
   * The visible element closest to a viewport point that lies within one box size of it
   * (so the stored fraction stays inside POS_MIN..POS_MAX). Ties go to the smaller element.
   */
  function nearestElement(clientX: number, clientY: number): Element | null {
    const body = doc.body;
    if (!body) return null;
    const all = body.getElementsByTagName("*");
    const candidates: { el: Element; d: number; area: number }[] = [];
    const n = Math.min(all.length, MAX_SCAN);
    for (let i = 0; i < n; i++) {
      const el = all[i]!;
      if (SKIP_TAGS.test(el.localName)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const fx = (clientX - r.left) / r.width;
      const fy = (clientY - r.top) / r.height;
      if (fx < POS_MIN || fx > POS_MAX || fy < POS_MIN || fy > POS_MAX) continue;
      const dx = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
      const dy = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
      candidates.push({ el, d: Math.hypot(dx, dy), area: r.width * r.height });
    }
    candidates.sort((a, b) => a.d - b.d || a.area - b.area);
    for (let i = 0; i < candidates.length && i < 12; i++) {
      if (isVisible(candidates[i]!.el)) return candidates[i]!.el;
    }
    return null;
  }

  function anchorFor(el: Element | null, clientX: number, clientY: number) {
    if (!el || el === doc.body || el === doc.documentElement) el = nearestElement(clientX, clientY);
    const found = el ? cssPath(el) : { path: null, element: null };
    if (found.path && found.element) {
      const r = found.element.getBoundingClientRect();
      return {
        targetPath: found.path,
        posX: r.width > 0 ? clampPos((clientX - r.left) / r.width) : 0.5,
        posY: r.height > 0 ? clampPos((clientY - r.top) / r.height) : 0.5,
      };
    }
    const box = docBox();
    return {
      targetPath: null,
      posX: clamp01((clientX + win.scrollX) / box.w),
      posY: clamp01((clientY + win.scrollY) / box.h),
    };
  }

  function resolve(anchor: BridgeAnchor): BridgePlace {
    const hidden = { threadId: anchor.threadId, x: 0, y: 0, visible: false };
    if (anchor.targetPath) {
      let el: Element | null = null;
      try {
        el = doc.querySelector(anchor.targetPath);
      } catch {
        return hidden; // not a valid selector
      }
      if (!el || !isVisible(el)) return hidden;
      const r = el.getBoundingClientRect();
      return {
        threadId: anchor.threadId,
        x: r.left + clampPos(anchor.posX) * r.width,
        y: r.top + clampPos(anchor.posY) * r.height,
        visible: true,
      };
    }
    const box = docBox();
    return {
      threadId: anchor.threadId,
      x: clamp01(anchor.posX) * box.w - win.scrollX,
      y: clamp01(anchor.posY) * box.h - win.scrollY,
      visible: true,
    };
  }

  function tag<T extends object>(type: string, payload: T): T & { dp: 1; type: string } {
    return Object.assign({}, payload, { dp: 1 as const, type });
  }

  const helpers: BridgeHelpers = { MAX_PATH, MAX_EXCERPT, POS_MIN, POS_MAX, cssPath, isVisible, anchorFor, resolve, tag };
  if (!install) return helpers;

  // ---- Runtime (inside the sandboxed frame) -------------------------------------------

  const parentWin = win.parent;
  // The frame is an opaque origin and can't know the parent's origin; the parent verifies
  // `event.source` instead. Nothing sent here is secret beyond what the parent already shows.
  const post = (type: string, payload: object) => {
    if (parentWin && parentWin !== win) parentWin.postMessage(tag(type, payload), "*");
  };

  let placing = false;
  let anchors: BridgeAnchor[] = [];
  let lastPlaces = "";
  let lastSize = "";
  let frameQueued = false;

  const styleEl = doc.createElement("style");
  styleEl.textContent =
    "html[data-dp-placing], html[data-dp-placing] * { cursor: crosshair !important; }";
  (doc.head || doc.documentElement).appendChild(styleEl);

  function emitSize(force: boolean) {
    const box = docBox();
    const key = box.w + "x" + box.h;
    if (!force && key === lastSize) return;
    lastSize = key;
    post(force ? "ready" : "size", { docW: box.w, docH: box.h });
  }

  function emitPlaces(force: boolean) {
    const places = anchors.map(resolve);
    const key = JSON.stringify(places);
    if (!force && key === lastPlaces) return;
    lastPlaces = key;
    post("places", { places });
  }

  // Coalesces bursts (mutations, scroll, animation frames) into one update per frame.
  function schedule() {
    if (frameQueued) return;
    frameQueued = true;
    win.requestAnimationFrame(() => {
      frameQueued = false;
      emitSize(false);
      if (anchors.length > 0) emitPlaces(false);
    });
  }

  function setPlacing(on: boolean) {
    placing = on;
    if (on) doc.documentElement.setAttribute("data-dp-placing", "");
    else doc.documentElement.removeAttribute("data-dp-placing");
  }

  function readAnchors(raw: unknown): BridgeAnchor[] | null {
    if (!Array.isArray(raw) || raw.length > MAX_ANCHORS) return null;
    const out: BridgeAnchor[] = [];
    for (const a of raw) {
      if (!a || typeof a !== "object") return null;
      const { threadId, targetPath, posX, posY } = a as Record<string, unknown>;
      if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > 64) return null;
      if (targetPath !== null && (typeof targetPath !== "string" || targetPath.length > MAX_PATH)) return null;
      if (typeof posX !== "number" || typeof posY !== "number") return null;
      if (!Number.isFinite(posX) || !Number.isFinite(posY)) return null;
      out.push({ threadId, targetPath: targetPath || null, posX: clampPos(posX), posY: clampPos(posY) });
    }
    return out;
  }

  win.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== parentWin) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object" || data.dp !== 1) return;
    if (data.type === "mode" && typeof data.placing === "boolean") {
      setPlacing(data.placing);
    } else if (data.type === "locate") {
      const next = readAnchors(data.anchors);
      if (!next) return;
      anchors = next;
      emitPlaces(true);
    }
  });

  // Placing mode swallows the page's own clicks and turns them into picks.
  function swallow(event: Event) {
    if (!placing) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }
  win.addEventListener("pointerdown", swallow, true);
  win.addEventListener("mousedown", swallow, true);
  win.addEventListener("mouseup", swallow, true);
  win.addEventListener("dblclick", swallow, true);
  win.addEventListener("auxclick", swallow, true);
  win.addEventListener(
    "click",
    (event: MouseEvent) => {
      if (!placing) return;
      swallow(event);
      const target = event.target instanceof Element ? event.target : null;
      const a = anchorFor(target, event.clientX, event.clientY);
      post("pick", {
        posX: a.posX,
        posY: a.posY,
        targetPath: a.targetPath,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    },
    true,
  );

  // Focus often sits inside this frame, where the parent can't hear keys or clicks. Forward
  // only what the canvas needs: Esc, the C shortcut, and "the page was clicked" (to dismiss).
  win.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const t = event.target instanceof Element ? event.target : null;
      const typing = !!t && (t.closest("input, textarea, select, [contenteditable]") !== null);
      if (event.key === "Escape") post("key", { key: "Escape" });
      else if ((event.key === "c" || event.key === "C") && !typing) post("key", { key: "c" });
    },
    true,
  );
  win.addEventListener(
    "pointerdown",
    () => {
      lastExcerptKey = ""; // a fresh gesture may re-select the same text
      if (!placing) post("tap", {});
    },
    { capture: true, passive: true },
  );

  // Text selection (any mode): offer "Comment on selection" at the selection's end.
  let selectionTimer = 0;
  let lastExcerptKey = "";
  function checkSelection() {
    const sel = win.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      lastExcerptKey = "";
      return;
    }
    const text = sel.toString().replace(/\s+/g, " ").trim();
    if (!text) return;
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const endRect = rects.length > 0 ? rects[rects.length - 1]! : range.getBoundingClientRect();
    const clientX = endRect.right;
    const clientY = endRect.bottom;
    const container = range.commonAncestorContainer;
    const el = container instanceof Element ? container : container.parentElement;
    const a = anchorFor(el, clientX, clientY);
    const excerpt = text.slice(0, MAX_EXCERPT);
    const key = excerpt + "|" + Math.round(clientX) + "|" + Math.round(clientY);
    if (key === lastExcerptKey) return;
    lastExcerptKey = key;
    post("pick", { posX: a.posX, posY: a.posY, targetPath: a.targetPath, excerpt, clientX, clientY });
  }
  function queueSelection() {
    win.clearTimeout(selectionTimer);
    selectionTimer = win.setTimeout(checkSelection, 250);
  }
  doc.addEventListener("mouseup", queueSelection, { passive: true });
  doc.addEventListener("selectionchange", queueSelection, { passive: true });

  // Keep the parent's markers following the page.
  let lastScroll = "";
  function onScroll() {
    const key = win.scrollX + "," + win.scrollY;
    if (key !== lastScroll) {
      lastScroll = key;
      post("scroll", { x: win.scrollX, y: win.scrollY });
    }
    schedule();
  }
  // Capture on document also sees scrolling inside inner containers (scroll doesn't bubble).
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  win.addEventListener("resize", schedule, { passive: true });
  doc.addEventListener("transitionend", schedule, { capture: true, passive: true });
  doc.addEventListener("animationend", schedule, { capture: true, passive: true });

  if (typeof win.ResizeObserver === "function") {
    new win.ResizeObserver(schedule).observe(doc.documentElement);
  }
  if (typeof win.MutationObserver === "function") {
    new win.MutationObserver(schedule).observe(doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }

  emitSize(true);
  return helpers;
}

let script: string | undefined;

/** The `<script>` element that runs the bridge. Built once per process. */
export function bridgeScript(): string {
  // biome-ignore lint/suspicious/noUselessEscapeInString: keeps this source from ever closing an inline <script> early
  script ??= "<script>(" + frameBridge.toString() + ")()<\/script>";
  return script;
}

/** Inserts the bridge before the last `</body>`, or appends it when there is none. */
export function injectBridge(html: string): string {
  const tag = bridgeScript();
  const match = /<\/body\s*>/gi;
  let last = -1;
  for (let m = match.exec(html); m; m = match.exec(html)) last = m.index;
  if (last === -1) return html + tag;
  return html.slice(0, last) + tag + html.slice(last);
}
