import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { requireAuth, type AppEnv } from "../auth/session";
import { db } from "../db";
import { memories } from "../db/schema";

const PAGE = 500;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Markdown of the organisation's active SHARED memory (facts only, grouped by source). Private channel and DM
 * memories are never exported. Pure function over rows so the format is testable.
 */
export function memoriesToMarkdown(rows: { text: string; source: string; sourceRef: string | null; permalink: string | null; createdAt: Date }[], at = new Date()): string {
  const bySource = new Map<string, typeof rows>();
  for (const r of rows) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);
  const out = [`# Company memory export`, ``, `Exported ${at.toISOString().slice(0, 10)} · ${rows.length} shared facts`];
  for (const [source, items] of [...bySource].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(``, `## ${source} (${items.length})`, ``);
    for (const r of items) {
      const ref = r.permalink ?? r.sourceRef;
      out.push(`- ${oneLine(r.text)} _(${r.createdAt.toISOString().slice(0, 10)}${ref ? `, ${ref}` : ""})_`);
    }
  }
  return out.join("\n") + "\n";
}

/** GET /export/memories (admin) -> text/markdown attachment. */
export function mountExportRoutes(api: Hono<AppEnv>): void {
  api.get("/export/memories", requireAuth("admin"), async (c) => {
    const rows: Parameters<typeof memoriesToMarkdown>[0] = [];
    let after = 0;
    for (;;) {
      const page = await db
        .select({ id: memories.id, text: memories.text, source: memories.source, sourceRef: memories.sourceRef, permalink: memories.permalink, createdAt: memories.createdAt })
        .from(memories)
        .where(and(eq(memories.scopeTag, "shared"), eq(memories.kind, "fact"), eq(memories.status, "active"), isNull(memories.invalidAt), eq(memories.reviewState, "ok"), gt(memories.id, after)))
        .orderBy(asc(memories.id))
        .limit(PAGE);
      rows.push(...page);
      if (page.length < PAGE) break;
      after = page[page.length - 1]!.id;
    }
    return new Response(memoriesToMarkdown(rows), {
      headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="company-memory-${new Date().toISOString().slice(0, 10)}.md"` },
    });
  });
}
