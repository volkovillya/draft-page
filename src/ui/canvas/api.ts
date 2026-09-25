import type { ThreadView } from "@/server/core/threads";

/** Calls a JSON API route; throws an Error carrying the server's message on failure. */
export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init?.method ?? "GET",
      headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch {
    throw new Error("Network error, check your connection and try again");
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (data as { error?: { message?: unknown } } | null)?.error?.message;
    throw new Error(typeof message === "string" && message ? message : `Request failed (${response.status})`);
  }
  return data as T;
}

/** GET /api/pages/[shortId]/threads?n=N. Accepts either a bare array or `{ threads }`. */
export async function fetchThreads(shortId: string, versionNumber: number): Promise<ThreadView[]> {
  const data = await api<unknown>(`/api/pages/${encodeURIComponent(shortId)}/threads?n=${versionNumber}`);
  const list = Array.isArray(data) ? data : (data as { threads?: unknown } | null)?.threads;
  if (!Array.isArray(list)) throw new Error("Unexpected response while loading comments");
  return list as ThreadView[];
}
