import { and, eq, sql } from "drizzle-orm";
import { id as newId } from "../crypto";
import { db } from "../db";
import { channelMembers, coreBlocks, memoryReviews } from "../db/schema";
import { type SlackScope } from "./scope";

/** Who is acting. Only "primary" (an interactive turn) and admin-approved reviews may write shared company state. */
export type AgentContext = "primary" | "automation" | "research" | "consolidation" | "reflection" | "untrusted";
export type BlockLabel = "company" | "channel" | "user";
export type Block = { scopeTag: string; label: BlockLabel; text: string; charLimit: number; version: number };
export type Actor = { userId: string | null; role: "owner" | "admin" | "member" | "bot"; agentContext: AgentContext };

export const BLOCK_LIMITS: Record<BlockLabel, number> = { company: 1500, channel: 1000, user: 1000 };


const THREATS: [RegExp, string][] = [
  [/ignore\s+(?:(?:all|any|the|your|previous|prior|above|earlier|preceding)\s+)+(?:instructions|rules|prompts?)/i, "prompt_injection"],
  [/you\s+are\s+now\s+/i, "role_hijack"],
  [/do\s+not\s+tell\s+the\s+user/i, "deception_hide"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [/disregard\s+(?:(?:your|all|any|the|previous|prior|above|earlier|preceding)\s+)+(?:instructions|rules|guidelines|prompts?)/i, "disregard_rules"],
  [/act\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)/i, "bypass_restrictions"],
  [/(reveal|print|show|repeat|leak)\s+(your\s+|the\s+)?(system\s+prompt|instructions|api\s*key|secrets?)/i, "exfil_prompt"],
  [/(curl|wget)\s+[^\n]*(\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)|https?:\/\/)/i, "exfil_http"],
  [/<\/?\s*(memory-context|system|instructions?|assistant|tool_result)\b/i, "fence_spoof"],
  [/authorized_keys|~\/\.ssh|\$HOME\/\.ssh/i, "ssh_access"],
];
const INVISIBLE = /[\u034F\u061C\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}]/u;

/** Returns a human-readable rejection reason, or null when the text is safe to inject into a prompt. */
export function scanMemoryText(text: string): string | null {
  const inv = INVISIBLE.exec(text);
  if (inv) return `Blocked: contains invisible unicode U+${inv[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} (possible injection).`;
  for (const [re, id] of THREATS) {
    if (re.test(text)) return `Blocked: matches threat pattern '${id}'. Memory is injected into prompts and must not contain instructions aimed at the assistant or exfiltration payloads.`;
  }
  return null;
}

const fmt = (n: number) => n.toLocaleString("en-US");
export const usageText = (len: number, limit: number) => `${fmt(len)}/${fmt(limit)}`;

export function blockTag(scope: SlackScope, label: BlockLabel): string | null {
  if (label === "company") return "shared";
  if (label === "channel") return scope.isIm ? null : `channel_${scope.channelId}`;
  return scope.userId ? `user_${scope.userId}` : null;
}

async function ensureBlock(scopeTag: string, label: BlockLabel): Promise<void> {
  await db.insert(coreBlocks).values({ id: newId("cb_"), scopeTag, label, text: "", charLimit: BLOCK_LIMITS[label] }).onConflictDoNothing();
}

async function loadBlock(scopeTag: string, label: BlockLabel): Promise<Block> {
  await ensureBlock(scopeTag, label);
  const [r] = await db.select().from(coreBlocks).where(and(eq(coreBlocks.scopeTag, scopeTag), eq(coreBlocks.label, label)));
  return { scopeTag, label, text: r!.text, charLimit: r!.charLimit, version: r!.version };
}

/** The three blocks visible to a scope (auto-created empty). channel is null in DMs, user is null without a user id. */
export async function getCoreBlocks(scope: SlackScope): Promise<{ company: Block | null; channel: Block | null; user: Block | null }> {
  const [company, channel, user] = await Promise.all((["company", "channel", "user"] as const).map(async (l) => {
    const tag = blockTag(scope, l);
    return tag ? loadBlock(tag, l) : null;
  }));
  return { company: company!, channel: channel ?? null, user: user ?? null };
}

type Verdict = { mode: "direct" } | { mode: "review" } | { mode: "deny"; error: string };

async function authorize(scope: SlackScope, label: BlockLabel, actor: Actor): Promise<Verdict> {
  const admin = actor.role === "admin" || actor.role === "owner";
  const interactive = actor.agentContext === "primary" || actor.agentContext === "reflection";
  if (label === "company") {
    if (actor.agentContext !== "primary") return { mode: "deny", error: `The ${actor.agentContext} context may not change the company profile.` };
    return admin ? { mode: "direct" } : { mode: "review" };
  }
  if (!interactive) return { mode: "deny", error: `The ${actor.agentContext} context may not change ${label} memory.` };
  if (label === "user") {
    if (!scope.userId) return { mode: "deny", error: "No user in this context." };
    return actor.role === "bot" || actor.userId === scope.userId ? { mode: "direct" } : { mode: "deny", error: "A user profile can only be changed by that user." };
  }
  if (scope.isIm) return { mode: "deny", error: "Direct messages have no channel block." };
  if (actor.role === "bot") return { mode: "direct" };
  if (!actor.userId) return { mode: "deny", error: "Not permitted." };
  if (admin && !scope.isPrivate) return { mode: "direct" };
  const [m] = await db.select().from(channelMembers).where(and(eq(channelMembers.channelId, scope.channelId), eq(channelMembers.userId, actor.userId)));
  return m ? { mode: "direct" } : { mode: "deny", error: "Only channel members can change the channel block." };
}

export type EditArgs = {
  scope: SlackScope; actor: Actor; label: BlockLabel; op: "add" | "replace" | "remove";
  text?: string; match?: string;
};
export type EditResult = { ok: boolean; usage: string; error?: string; queuedForReview?: boolean };

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

function applyOp(cur: string, op: EditArgs["op"], text: string | undefined, match: string | undefined): { next: string } | { error: string } {
  const lines = cur ? cur.split("\n") : [];
  if (op === "add") {
    const entry = oneLine(text ?? "");
    if (!entry) return { error: "text is required for add." };
    if (lines.includes(entry)) return { next: cur };
    return { next: [...lines, entry].join("\n") };
  }
  const m = (match ?? "").trim();
  if (!m) return { error: `match is required for ${op}.` };
  const idx = lines.map((l, i) => (l.includes(m) ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return { error: `No entry contains "${m.slice(0, 60)}".` };
  if (idx.length > 1) return { error: `${idx.length} entries contain "${m.slice(0, 60)}"; use a more specific match.` };
  if (op === "remove") return { next: lines.filter((_, i) => i !== idx[0]).join("\n") };
  const entry = oneLine(text ?? "");
  if (!entry) return { error: "text is required for replace." };
  return { next: lines.map((l, i) => (i === idx[0] ? entry : l)).join("\n") };
}

/** Writes block text under a row lock: scan -> limit -> version bump. */
export async function commit(tag: string, label: BlockLabel, updatedBy: string | null, compute: (cur: string) => { next: string } | { error: string }): Promise<EditResult> {
  await ensureBlock(tag, label);
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(coreBlocks).where(and(eq(coreBlocks.scopeTag, tag), eq(coreBlocks.label, label))).for("update");
    const limit = row!.charLimit;
    const r = compute(row!.text);
    if ("error" in r) return { ok: false, usage: usageText(row!.text.length, limit), error: r.error };
    const bad = scanMemoryText(r.next);
    if (bad) return { ok: false, usage: usageText(row!.text.length, limit), error: bad };
    if (r.next.length > limit) {
      return {
        ok: false, usage: usageText(row!.text.length, limit),
        error: `Rejected: that would make the block ${usageText(r.next.length, limit)} chars. Remove or shorten existing entries first.`,
      };
    }
    if (r.next !== row!.text) {
      await tx.update(coreBlocks).set({ text: r.next, version: sql`${coreBlocks.version} + 1`, updatedBy, updatedAt: new Date() })
        .where(eq(coreBlocks.id, row!.id));
    }
    return { ok: true, usage: usageText(r.next.length, limit) };
  });
}

/** Add/replace/remove an entry in a core block, enforcing the write-permission matrix, scan and char limit. */
export async function coreMemoryEdit(a: EditArgs): Promise<EditResult> {
  const tag = blockTag(a.scope, a.label);
  if (!tag) return { ok: false, usage: "0/0", error: `No ${a.label} block in this context.` };
  const limit = BLOCK_LIMITS[a.label];
  const v = await authorize(a.scope, a.label, a.actor);
  if (v.mode === "deny") return { ok: false, usage: usageText((await loadBlock(tag, a.label)).text.length, limit), error: v.error };
  const proposed = [a.text, a.match].filter(Boolean).join("\n");
  const bad = scanMemoryText(proposed);
  if (bad) return { ok: false, usage: usageText((await loadBlock(tag, a.label)).text.length, limit), error: bad };
  if (v.mode === "review") {
    // Validate against the live block first so reviewers never see an edit that cannot apply.
    const cur = await loadBlock(tag, a.label);
    const dry = applyOp(cur.text, a.op, a.text, a.match);
    if ("error" in dry) return { ok: false, usage: usageText(cur.text.length, limit), error: dry.error };
    if (dry.next.length > limit) {
      return { ok: false, usage: usageText(cur.text.length, limit), error: `Rejected: that would make the block ${usageText(dry.next.length, limit)} chars.` };
    }
    await db.insert(memoryReviews).values({
      id: newId("rv_"), kind: "core_block", payload: { label: a.label, tag, op: a.op, text: a.text ?? null, match: a.match ?? null },
      requestedBy: a.actor.userId,
    });
    return { ok: true, usage: usageText(cur.text.length, limit), queuedForReview: true };
  }
  return commit(tag, a.label, a.actor.userId, (cur) => applyOp(cur, a.op, a.text, a.match));
}

/** Full replace (web editor). Same permission matrix as coreMemoryEdit; company edits by non-admins are queued as a replace-all review. */
export async function setCoreBlockText(a: { scope: SlackScope; actor: Actor; label: BlockLabel; text: string }): Promise<EditResult> {
  const tag = blockTag(a.scope, a.label);
  if (!tag) return { ok: false, usage: "0/0", error: `No ${a.label} block in this context.` };
  const limit = BLOCK_LIMITS[a.label];
  const v = await authorize(a.scope, a.label, a.actor);
  const cur = await loadBlock(tag, a.label);
  if (v.mode === "deny") return { ok: false, usage: usageText(cur.text.length, limit), error: v.error };
  const text = a.text.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  if (v.mode === "review") {
    const bad = scanMemoryText(text);
    if (bad) return { ok: false, usage: usageText(cur.text.length, limit), error: bad };
    if (text.length > limit) return { ok: false, usage: usageText(cur.text.length, limit), error: `Rejected: ${usageText(text.length, limit)} chars.` };
    await db.insert(memoryReviews).values({ id: newId("rv_"), kind: "core_block", payload: { label: a.label, tag, op: "set", text, match: null }, requestedBy: a.actor.userId });
    return { ok: true, usage: usageText(cur.text.length, limit), queuedForReview: true };
  }
  return commit(tag, a.label, a.actor.userId, () => ({ next: text }));
}

/** Applies a previously queued core_block review (called by review.ts after an admin approves). */
export async function applyCoreBlockReview(payload: { label: BlockLabel; tag: string; op: "add" | "replace" | "remove" | "set"; text: string | null; match: string | null }, decidedBy: string): Promise<EditResult> {
  return commit(payload.tag, payload.label, decidedBy, (cur) =>
    payload.op === "set" ? { next: payload.text ?? "" } : applyOp(cur, payload.op, payload.text ?? undefined, payload.match ?? undefined));
}
