"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * A small dropdown menu: a trigger plus a popover list. Closes on outside click, Esc, and
 * after an item runs. Arrow keys move between items.
 */
export function Menu({
  trigger,
  label,
  align = "start",
  width = 280,
  className = "",
  children,
}: {
  trigger: (props: { open: boolean; toggle: () => void; id: string }) => ReactNode;
  label: string;
  align?: "start" | "end";
  width?: number;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    // Clicks inside an iframe (the page preview) never reach this document; the window only
    // loses focus. Closing on blur covers that, and switching tabs or apps.
    const onBlur = () => setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    list.current?.querySelector<HTMLElement>("[role^=menuitem]:not([aria-disabled=true])")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  function onListKey(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(list.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
  }

  return (
    <div ref={root} className={`relative ${className}`.trim()}>
      {trigger({ open, toggle: () => setOpen((o) => !o), id })}
      {open ? (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={onListKey}
          style={{ width: `min(${width}px, calc(100vw - 16px))` }}
          className={
            "dp-pop absolute top-full z-40 mt-1.5 max-h-[70vh] overflow-y-auto rounded-xl bg-raised p-1.5 shadow-[var(--shadow-pop)] " +
            (align === "end" ? "right-0" : "left-0")
          }
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  onSelect,
  icon,
  children,
  hint,
  checked,
  href,
  download,
  danger,
}: {
  onSelect?: () => void;
  icon?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  checked?: boolean;
  href?: string;
  download?: string;
  danger?: boolean;
}) {
  const cls =
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none " +
    "hover:bg-hover focus-visible:bg-hover [&_svg]:size-4 [&_svg]:shrink-0 " +
    (danger ? "text-danger [&_svg]:text-danger" : "text-ink [&_svg]:text-muted");
  const body = (
    <>
      {icon ?? null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="shrink-0 text-xs text-muted">{hint}</span> : null}
      {checked !== undefined ? (
        <span aria-hidden="true" className={"size-1.5 rounded-full " + (checked ? "bg-marker" : "bg-transparent")} />
      ) : null}
    </>
  );
  if (href) {
    return (
      <a role="menuitem" tabIndex={-1} href={href} download={download} onClick={onSelect} className={cls}>
        {body}
      </a>
    );
  }
  // A checkable item (the version picker) is a radio; aria-checked is only valid there.
  if (checked !== undefined) {
    return (
      <button role="menuitemradio" tabIndex={-1} type="button" onClick={onSelect} aria-checked={checked} className={cls}>
        {body}
      </button>
    );
  }
  return (
    <button role="menuitem" tabIndex={-1} type="button" onClick={onSelect} className={cls}>
      {body}
    </button>
  );
}

export function MenuSeparator() {
  return <hr className="my-1 h-px border-0 bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted">{children}</div>;
}
