"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { FileCode2, UploadCloud, X } from "lucide-react";
import { Button, IconButton } from "@/ui/common/Button";
import { api } from "./api";

const MAX_BYTES = 2 * 1024 * 1024;

/** Owner-only: paste HTML or pick a file, POST it as a new draft version, then open it. */
export function AddVersionDialog({
  shortId,
  open,
  onClose,
}: {
  shortId: string;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [html, setHtml] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Syncs the native <dialog> (focus trap, Esc, backdrop) with the `open` prop.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  async function pickFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!/\.html?$/i.test(file.name) && file.type !== "text/html") {
      setError("Choose an .html file");
      return;
    }
    if (file.size === 0 || file.size > MAX_BYTES) {
      setError("The file must be between 1 byte and 2 MiB");
      return;
    }
    setHtml(await file.text());
    setFileName(file.name);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!html.trim()) {
      setError("Paste HTML or choose a file");
      return;
    }
    if (new Blob([html]).size > MAX_BYTES) {
      setError("HTML is larger than 2 MiB");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ number?: unknown }>(`/api/pages/${encodeURIComponent(shortId)}/versions`, {
        method: "POST",
        body: { html },
      });
      const n = typeof created?.number === "number" ? created.number : null;
      setHtml("");
      setFileName(null);
      onClose();
      router.push(n ? `/pages/${encodeURIComponent(shortId)}?n=${n}` : `/pages/${encodeURIComponent(shortId)}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="add-version-title"
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-2xl bg-raised p-0 text-ink shadow-[var(--shadow-pop)] backdrop:bg-black/55 backdrop:backdrop-blur-[2px]"
    >
      <form onSubmit={submit} className="flex flex-col">
        <div className="flex items-start gap-3 px-6 pt-5">
          <div className="flex-1">
            <h2 id="add-version-title" className="font-serif text-[22px] font-medium">
              Upload a new version
            </h2>
            <p className="mt-1 text-sm text-soft">It starts as a draft. Open comments carry over to it.</p>
          </div>
          <IconButton label="Close" onClick={onClose} className="-mr-2">
            <X />
          </IconButton>
        </div>

        <div className="flex flex-col gap-4 px-6 pt-5 pb-2">
          <label className="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-line-strong px-4 py-4 transition-colors hover:bg-hover/60">
            <span className="flex size-9 items-center justify-center rounded-full bg-hover text-soft">
              {fileName ? <FileCode2 className="size-[18px]" /> : <UploadCloud className="size-[18px]" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">{fileName ?? "Choose an .html file"}</span>
              <span className="block text-xs text-muted">{fileName ? "Loaded. You can still edit it below." : "Up to 2 MiB"}</span>
            </span>
            <input
              type="file"
              accept=".html,.htm,text/html"
              onChange={(e) => void pickFile(e.target.files?.[0])}
              className="sr-only"
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-soft">Or paste HTML</span>
            <textarea
              value={html}
              onChange={(e) => {
                setHtml(e.target.value);
                setFileName(null);
              }}
              rows={8}
              spellCheck={false}
              placeholder="<!doctype html>…"
              aria-label="HTML"
              className="rounded-lg bg-canvas px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink ring-1 ring-line-strong ring-inset outline-none placeholder:text-muted focus:ring-2 focus:ring-marker"
            />
          </div>
          {error ? (
            <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 px-6 pt-3 pb-5">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="inverse" disabled={busy}>
            {busy ? "Uploading…" : "Upload version"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
