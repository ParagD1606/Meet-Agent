import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { memories } from "../db/schema";
import { log } from "../log";
import { embed } from "./embed";
import { completeJson } from "./llm";
import { clearRecallCache } from "./recall";
import { embedText } from "./supersede";

const BATCH = 20;
const reply = z.object({ contexts: z.array(z.object({ id: z.number().int(), context: z.string() })) });

const SYSTEM = `You write retrieval context lines for company-memory facts. For each numbered fact, write ONE short line (under 20 words) that situates it: who it concerns or who said it, the channel or topic area, the date, and the subject. Do not repeat the fact itself and never invent details that are not in the input; if unsure, give only the date and topic.
Reply with JSON only: {"contexts":[{"id":<id>,"context":"..."}]}.`;

const scopeLabel = (tag: string) => (tag === "shared" ? "company-wide" : tag.startsWith("channel_") ? "a channel" : "a private note");

/**
 * Lazy backfill: gives up to `limit` prefix-less facts a contextual one-liner, then re-embeds them with it (the generated
 * tsvector picks the prefix up on update). Rows the model skips get "" so they are not retried forever; an LLM or
 * embedding failure leaves them null for the next run. Returns how many rows were updated.
 */
export async function backfillContextPrefixes(limit = 100): Promise<number> {
  const rows = await db.select({ id: memories.id, text: memories.text, source: memories.source, scopeTag: memories.scopeTag, validAt: memories.validAt })
    .from(memories)
    .where(and(isNull(memories.contextPrefix), eq(memories.kind, "fact"), eq(memories.status, "active")))
    .orderBy(sql`${memories.id} desc`)
    .limit(limit);
  let done = 0;
  // a batch never mixes scopes: the model sees one prompt, and a private fact's details must not leak into a shared fact's prefix
  const byScope = new Map<string, typeof rows>();
  for (const r of rows) byScope.set(r.scopeTag, [...(byScope.get(r.scopeTag) ?? []), r]);
  const batches = [...byScope.values()].flatMap((g) => Array.from({ length: Math.ceil(g.length / BATCH) }, (_, i) => g.slice(i * BATCH, (i + 1) * BATCH)));
  for (const batch of batches) {
    try {
      const prompt = batch.map((r) => `[${r.id}] (${r.source}, ${scopeLabel(r.scopeTag)}, ${r.validAt.toISOString().slice(0, 10)}) ${r.text.slice(0, 400)}`).join("\n");
      const out = await completeJson({ system: SYSTEM, prompt, role: "extract", maxOutputTokens: 1500 }, reply);
      const byId = new Map(out.contexts.map((c) => [c.id, c.context.trim().slice(0, 200)]));
      const ctx = batch.map((r) => byId.get(r.id) ?? "");
      const withCtx = batch.map((r, k) => ({ r, c: ctx[k]! })).filter((x) => x.c);
      const vecs = withCtx.length ? await embed(withCtx.map((x) => embedText(x.r.text, x.c))) : [];
      const vecOf = new Map(withCtx.map((x, k) => [x.r.id, vecs[k]!]));
      for (const [k, r] of batch.entries()) {
        const res = await db.update(memories).set({ contextPrefix: ctx[k]!, ...(vecOf.has(r.id) ? { embedding: vecOf.get(r.id)! } : {}) })
          .where(and(eq(memories.id, r.id), isNull(memories.contextPrefix)));
        done += res.rowCount ?? 0;
      }
    } catch (e) {
      log.warn("context prefix backfill batch failed", { err: String(e) });
    }
  }
  if (done) clearRecallCache();
  return done;
}
