import { config } from "../../src/config";
import { db } from "../../src/db";
import { channelMembers, channels, memories } from "../../src/db/schema";
import { embed, setEmbedder } from "../../src/memory/embed";
import { setMemoryLlm } from "../../src/memory/llm";

/** Deterministic bag-of-words embedder: shared words => high cosine similarity; unrelated text ~ 0. */
export function fakeVector(text: string): number[] {
  const v = new Array<number>(config.EMBEDDING_DIM).fill(0);
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let h = 2166136261;
    for (const ch of w) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
    v[h % v.length]! += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

export function installFakes() {
  setEmbedder(async (texts) => texts.map(fakeVector));
  setMemoryLlm(async () => '{"superseded":[],"facts":[]}');
}
export function removeFakes() {
  setEmbedder(null);
  setMemoryLlm(null);
}

export async function seedMemory(scopeTag: string, text: string, extra: Partial<typeof memories.$inferInsert> = {}) {
  const [v] = await embed([text]);
  const [r] = await db.insert(memories).values({ scopeTag, text, embedding: v!, ...extra }).returning({ id: memories.id });
  return r!.id;
}

export async function seedChannel(id: string, opts: { isPrivate?: boolean; isIm?: boolean; members?: string[] }) {
  await db.insert(channels).values({ id, isPrivate: opts.isPrivate ?? false, isIm: opts.isIm ?? false, botIsMember: true });
  if (opts.members?.length) await db.insert(channelMembers).values(opts.members.map((userId) => ({ channelId: id, userId })));
}
