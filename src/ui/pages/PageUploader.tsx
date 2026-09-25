"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type DragEvent, type FormEvent } from "react";
import { FileCode2, UploadCloud } from "lucide-react";
import { Button } from "@/ui/common/Button";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TITLE = 200;

type Source = "file" | "paste";
type Loaded = { name: string; html: string; bytes: number };

const byteLength = (text: string) => new TextEncoder().encode(text).length;
const stem = (filename: string) => filename.replace(/\.html?$/i, "").trim().slice(0, MAX_TITLE);
const isHtmlFile = (file: File) => /\.html?$/i.test(file.name) || file.type === "text/html";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function PageUploader() {
  const router = useRouter();
  const ids = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<Source>("file");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [pasted, setPasted] = useState("");
  const [title, setTitle] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const html = source === "file" ? (loaded?.html ?? "") : pasted;
  const canSubmit = html.trim().length > 0 && title.trim().length > 0 && !pending;

  async function acceptFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!isHtmlFile(file)) return setError("Choose an .html file.");
    if (file.size > MAX_BYTES) return setError(`That file is ${formatBytes(file.size)}; the limit is 2 MiB.`);
    const text = await file.text();
    if (!text.trim()) return setError("That file is empty.");
    setLoaded({ name: file.name, html: text, bytes: byteLength(text) });
    if (!titleEdited) setTitle(stem(file.name));
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    void acceptFile(event.dataTransfer.files[0]);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!html.trim()) return setError(source === "file" ? "Choose a file first." : "Paste some HTML first.");
    if (byteLength(html) > MAX_BYTES) return setError("The HTML is larger than 2 MiB.");
    const cleanTitle = title.trim();
    if (!cleanTitle) return setError("Give the page a title.");

    startTransition(async () => {
      try {
        const res = await fetch("/api/pages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: cleanTitle, html }),
        });
        const data = (await res.json().catch(() => null)) as
          | { shortId?: string; error?: { message?: string } }
          | null;
        if (!res.ok || !data?.shortId) {
          setError(data?.error?.message ?? `Upload failed (${res.status}).`);
          return;
        }
        router.push(`/pages/${data.shortId}`);
      } catch {
        setError("Couldn't reach the server. Check your connection and try again.");
      }
    });
  }

  const tabClass = (active: boolean) =>
    `h-7 rounded-md px-3 text-[13px] font-medium transition-colors ${
      active ? "bg-panel text-ink shadow-sm ring-1 ring-line" : "text-muted hover:text-ink"
    }`;
  const field =
    "w-full rounded-lg bg-panel px-3 text-sm text-ink ring-1 ring-line-strong ring-inset placeholder:text-muted " +
    "focus:ring-2 focus:ring-marker focus:outline-none";

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-title`} className="text-[13px] font-medium text-soft">
          Title
        </label>
        <input
          id={`${ids}-title`}
          type="text"
          value={title}
          maxLength={MAX_TITLE}
          required
          placeholder="e.g. Pricing page redesign"
          onChange={(e) => {
            setTitle(e.target.value);
            setTitleEdited(true);
          }}
          className={`${field} h-10`}
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-soft">HTML</span>
          <div role="tablist" aria-label="HTML source" className="inline-flex gap-0.5 rounded-lg bg-hover p-0.5">
            <button type="button" role="tab" aria-selected={source === "file"} className={tabClass(source === "file")} onClick={() => setSource("file")}>
              File
            </button>
            <button type="button" role="tab" aria-selected={source === "paste"} className={tabClass(source === "paste")} onClick={() => setSource("paste")}>
              Paste
            </button>
          </div>
        </div>

        {source === "file" ? (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileInput.current?.click()}
            className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
              dragging ? "border-marker bg-marker/5" : "border-line-strong bg-panel hover:bg-hover/50"
            }`}
          >
            <span className="flex size-11 items-center justify-center rounded-full bg-hover text-soft">
              {loaded ? <FileCode2 className="size-5" /> : <UploadCloud className="size-5" />}
            </span>
            {loaded ? (
              <p className="text-sm text-ink">
                <span className="font-medium">{loaded.name}</span>
                <span className="text-muted"> · {formatBytes(loaded.bytes)}</span>
              </p>
            ) : (
              <div>
                <p className="text-sm font-medium text-ink">Drop an .html file here</p>
                <p className="mt-0.5 text-[13px] text-muted">or click to browse · up to 2 MiB</p>
              </div>
            )}
            {loaded ? <span className="text-[13px] text-marker">Choose another file</span> : null}
            <input
              ref={fileInput}
              id={`${ids}-file`}
              type="file"
              accept=".html,.htm,text/html"
              className="sr-only"
              aria-label="HTML file"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                void acceptFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        ) : (
          <textarea
            id={`${ids}-paste`}
            aria-label="HTML"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={14}
            spellCheck={false}
            placeholder="<!doctype html>…"
            className={`${field} py-2.5 font-mono text-[12.5px] leading-relaxed`}
          />
        )}
      </div>

      {error ? (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2 border-t border-line pt-5">
        <Button variant="ghost" onClick={() => router.push("/pages")}>
          Cancel
        </Button>
        <Button type="submit" variant="inverse" disabled={!canSubmit} aria-busy={pending}>
          {pending ? "Uploading…" : "Create page"}
        </Button>
      </div>
    </form>
  );
}
