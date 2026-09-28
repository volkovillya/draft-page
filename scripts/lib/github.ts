// Minimal GitHub REST client for the CI scripts (fetch + GITHUB_TOKEN, no dependencies).

export const BOT = "github-actions[bot]";

export type Item = {
  id: number;
  number: number;
  body?: string;
  state?: string;
  user?: { login: string };
  pull_request?: unknown;
};

export class GitHubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request(method: string, path: string, body: unknown, accept: string): Promise<Response> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new GitHubError(`GitHub ${method} ${path}: ${res.status}`, res.status);
  return res;
}

export async function github(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await request(method, path, body, "application/vnd.github+json");
  return res.status === 204 ? null : res.json();
}

/** A pull request as a unified diff. */
export async function pullRequestDiff(repo: string, number: number): Promise<string> {
  return (await request("GET", `/repos/${repo}/pulls/${number}`, undefined, "application/vnd.github.diff")).text();
}

/** Every page of a list endpoint (100 per page). */
export async function all(path: string): Promise<Item[]> {
  const items: Item[] = [];
  for (let page = 1; ; page++) {
    const batch = (await github("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)) as Item[];
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

/** Our own comment or issue: written by the Actions bot and carrying the marker. */
export const ours = (marker: string) => (i: Item) => i.user?.login === BOT && (i.body ?? "").includes(marker);
