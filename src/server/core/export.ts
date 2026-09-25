import { eq } from "drizzle-orm";
import type { Db } from "../db/connection";
import { pages, pageVersions } from "../db/tables";
import type { Actor } from "./actor";
import { missing } from "./failures";
import { requireMember, requireUuid } from "./guards";
import { listThreads } from "./threads";

/**
 * A Markdown digest of the threads visible on one version, for pasting into other tools.
 * `baseUrl` is the app origin; the digest links back to this exact version.
 */
export async function exportReview(
  db: Db,
  actor: Actor,
  versionId: string,
  baseUrl: string,
): Promise<{ markdown: string; filename: string }> {
  requireMember(actor);
  requireUuid(versionId, "Version");
  const [row] = await db
    .select({
      title: pages.title,
      shortId: pages.shortId,
      number: pageVersions.number,
      state: pageVersions.state,
    })
    .from(pageVersions)
    .innerJoin(pages, eq(pages.id, pageVersions.pageId))
    .where(eq(pageVersions.id, versionId));
  if (!row) throw missing("Version");

  const reviewUrl = `${baseUrl.replace(/\/+$/, "")}/pages/${row.shortId}?n=${row.number}`;
  const list = await listThreads(db, actor, versionId);
  const open = list.filter((t) => !t.closedAt);
  const lines = [
    `# Review: ${row.title}`,
    "",
    `Version ${row.number} (${row.state}) · ${open.length} open, ${list.length - open.length} resolved`,
    `Link: ${reviewUrl}`,
    "",
  ];
  list.forEach((t, i) => {
    const status = t.closedAt ? "resolved" : "open";
    const origin = t.carried ? `, from v${t.openedOnNumber}` : "";
    lines.push(`## ${i + 1}. ${status}${origin}${t.claudeRequestedAt ? " · Claude requested" : ""}`);
    if (t.targetPath) lines.push(`Target: \`${t.targetPath}\``);
    if (t.excerpt) lines.push(`> ${t.excerpt.replace(/\n/g, "\n> ")}`);
    lines.push("");
    for (const m of t.messages) lines.push(`- **${m.senderName}:** ${m.text.replace(/\n/g, "\n  ")}`);
    lines.push("");
  });
  return { markdown: lines.join("\n"), filename: `review-${row.shortId}-v${row.number}.md` };
}
