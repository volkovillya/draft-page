// Parses a pull request's unified diff and picks what the reviewer sees within its budget.

export type DiffFile = {
  path: string;
  deleted: boolean;
  patch: string;
  /** New-file line numbers GitHub accepts inline comments on (added and context lines). */
  lines: Set<number>;
};

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let newLine = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(line);
      file = { path: m?.[1] ?? "", deleted: false, patch: "", lines: new Set() };
      files.push(file);
      continue;
    }
    if (!file) continue;
    // Header lines come only before a file's first hunk; after it, "+++ x" is an added "++ x".
    if (!file.patch) {
      if (line.startsWith("+++ ")) {
        if (line !== "+++ /dev/null") file.path = line.slice(4).replace(/^b\//, "");
        else file.deleted = true;
        continue;
      }
      if (line.startsWith("--- ") || line.startsWith("index ") || /^(new|deleted) file mode|^similarity|^rename /.test(line)) {
        continue;
      }
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      file.patch += `${line}\n`;
      continue;
    }
    if (!file.patch) continue; // binary files and mode-only changes have no hunks
    if (line.startsWith("+") || line.startsWith(" ")) {
      file.lines.add(newLine);
      file.patch += `${newLine}${line[0]} ${line.slice(1)}\n`;
      newLine++;
    } else if (line.startsWith("-")) {
      file.patch += `   - ${line.slice(1)}\n`;
    }
  }
  return files.filter((f) => f.path && f.patch);
}

/** Generated or bulky files the model doesn't need to read. */
const NOT_REVIEWED = [/(^|\/)package-lock\.json$/, /^drizzle\/meta\//, /\.(png|jpe?g|gif|ico|webp|woff2?)$/];
/** Changes that alone don't need an AI review. */
const DOCS = [/\.md$/, /(^|\/)package-lock\.json$/, /^LICENSE$/];

export const isReviewed = (path: string) => !NOT_REVIEWED.some((re) => re.test(path));
export const docsOnly = (paths: string[]) => paths.every((p) => DOCS.some((re) => re.test(p)));

// Where bugs cost the most comes first when the diff has to be cut.
const PRIORITY = [
  /^src\/server\//,
  /^src\/ai\//,
  /^src\/worker\//,
  /^src\/app\/api\//,
  /^infra\//,
  /^\.github\//,
  /^drizzle\//,
  /^src\//,
  /^scripts\//,
  /^tests\//,
];
const rank = (path: string) => {
  const i = PRIORITY.findIndex((re) => re.test(path));
  return i === -1 ? PRIORITY.length : i;
};

export type Selection = { included: DiffFile[]; omitted: string[] };

/** Whole files in priority order until the byte budget is used up; the rest are listed as omitted. */
export function selectFiles(files: DiffFile[], maxBytes: number): Selection {
  const candidates = files.filter((f) => isReviewed(f.path) && !f.deleted);
  const ordered = [...candidates].sort((a, b) => rank(a.path) - rank(b.path) || a.patch.length - b.patch.length);
  const included: DiffFile[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const f of ordered) {
    const size = Buffer.byteLength(f.patch);
    if (used + size <= maxBytes) {
      included.push(f);
      used += size;
    } else {
      omitted.push(f.path);
    }
  }
  return { included, omitted };
}

export type Plan = { kind: "skip" } | { kind: "too-large"; omitted: string[] } | ({ kind: "review" } & Selection);

/**
 * What a run does with a diff: nothing when only docs, lockfiles or other unreviewed files
 * changed; no model call when every reviewable file is over the budget; otherwise a review.
 */
export function planReview(files: DiffFile[], maxBytes: number): Plan {
  if (files.length === 0 || docsOnly(files.map((f) => f.path))) return { kind: "skip" };
  const selection = selectFiles(files, maxBytes);
  if (selection.included.length > 0) return { kind: "review", ...selection };
  return selection.omitted.length > 0 ? { kind: "too-large", omitted: selection.omitted } : { kind: "skip" };
}
