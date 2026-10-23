import { tool, type ToolSet } from "ai";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { id as newId } from "../crypto";
import { db } from "../db";
import { settings, skills } from "../db/schema";

export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 200;
export const SKILL_BODY_MAX_BYTES = 16 * 1024;
export const SKILL_CAP = 100;
export const USER_SKILL_CAP = 20;
/** load_skill never returns more than this many chars of a body (progressive disclosure). */
export const LOAD_SKILL_MAX_CHARS = 8000;
const INDEX_DESC_MAX = 100;
export const WORKSPACE_PROMPT_MAX = 8000;

export class SkillError extends Error {
  constructor(message: string, readonly code: "invalid" | "conflict" | "limit" | "not_found" | "forbidden") {
    super(message);
  }
}

export type Skill = typeof skills.$inferSelect;
export type SkillInput = {
  name: string; description: string; body: string; enabled?: boolean; createdBy?: string | null;
  /** Default "org". "user" skills are visible to and editable by `ownerUserId` only. */
  scope?: "org" | "user"; ownerUserId?: string | null;
};
export type SkillViewer = { userId: string; role: "owner" | "admin" | "member" };

const squash = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");
const normName = (s: string) => s.toLocaleLowerCase();
const isAdmin = (v: SkillViewer) => v.role === "admin" || v.role === "owner";

function validate(input: Partial<SkillInput>): { name: string; description: string; body: string } {
  const name = squash(input.name);
  const description = squash(input.description);
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!name) throw new SkillError("name required", "invalid");
  if (!description) throw new SkillError("description required", "invalid");
  if (!body) throw new SkillError("body required", "invalid");
  if (name.length > SKILL_NAME_MAX) throw new SkillError(`name must be ${SKILL_NAME_MAX} characters or fewer`, "invalid");
  if (description.length > SKILL_DESCRIPTION_MAX)
    throw new SkillError(`description must be ${SKILL_DESCRIPTION_MAX} characters or fewer`, "invalid");
  if (new TextEncoder().encode(body).byteLength > SKILL_BODY_MAX_BYTES)
    throw new SkillError(`body must be ${SKILL_BODY_MAX_BYTES} bytes or fewer`, "invalid");
  return { name, description, body };
}

// ponytail: skills.name is globally unique in the schema, so personal skills share one namespace with org skills.
// Integrator: swap to a unique index on (lower(name), coalesce(owner_user_id,'')) to make names per-owner.
async function assertNameFree(name: string, exceptId?: string) {
  const rows = await db.select({ id: skills.id }).from(skills).where(sql`lower(${skills.name}) = ${normName(name)}`);
  if (rows.some((r) => r.id !== exceptId)) throw new SkillError("a skill with that name already exists", "conflict");
}

const isUniqueViolation = (e: unknown) => (e as { code?: string; cause?: { code?: string } })?.code === "23505" || (e as { cause?: { code?: string } })?.cause?.code === "23505";

/** Org skills + the viewer's own personal ones. Without a viewer: everything (internal/back-compat). */
export function listSkills(viewer?: SkillViewer): Promise<Skill[]> {
  const q = db.select().from(skills);
  return (viewer ? q.where(or(eq(skills.scope, "org"), eq(skills.ownerUserId, viewer.userId))) : q).orderBy(asc(skills.name));
}

/** Org skills need an admin; personal skills only their owner (admins can NOT edit other people's personal skills). */
export function canManageSkill(s: Pick<Skill, "scope" | "ownerUserId">, v: SkillViewer): boolean {
  return s.scope === "org" ? isAdmin(v) : s.ownerUserId === v.userId;
}

export async function createSkill(input: SkillInput): Promise<Skill> {
  const v = validate(input);
  const scope = input.scope ?? "org";
  if (scope === "user" && !input.ownerUserId) throw new SkillError("personal skills need an owner", "invalid");
  await assertNameFree(v.name);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(skills).where(scope === "user" ? eq(skills.ownerUserId, input.ownerUserId!) : eq(skills.scope, "org"));
  const cap = scope === "user" ? USER_SKILL_CAP : SKILL_CAP;
  if (n! >= cap) throw new SkillError(`skill limit reached (${cap})`, "limit");
  try {
    const [row] = await db
      .insert(skills)
      .values({ id: newId("sk_"), ...v, enabled: input.enabled ?? true, createdBy: input.createdBy ?? input.ownerUserId ?? null, scope, ownerUserId: scope === "user" ? input.ownerUserId! : null })
      .returning();
    return row!;
  } catch (e) {
    if (isUniqueViolation(e)) throw new SkillError("a skill with that name already exists", "conflict");
    throw e;
  }
}

/**
 * Patch a skill. With `expectedVersion` the update is an atomic compare-and-set on `version`
 * (conflict if someone saved first); every successful update bumps `version`.
 */
export async function updateSkill(skillId: string, patch: Partial<SkillInput>, opts: { expectedVersion?: number } = {}): Promise<Skill> {
  const [cur] = await db.select().from(skills).where(eq(skills.id, skillId));
  if (!cur) throw new SkillError("skill not found", "not_found");
  if (opts.expectedVersion !== undefined && cur.version !== opts.expectedVersion)
    throw new SkillError(`skill changed since you loaded it (now version ${cur.version})`, "conflict");
  const v = validate({ name: cur.name, description: cur.description, body: cur.body, ...patch });
  await assertNameFree(v.name, skillId);
  const [row] = await db
    .update(skills)
    .set({ ...v, enabled: patch.enabled ?? cur.enabled, version: sql`${skills.version} + 1` })
    .where(and(eq(skills.id, skillId), eq(skills.version, cur.version)))
    .returning();
  if (!row) throw new SkillError("skill changed since you loaded it", "conflict");
  return row;
}

export async function deleteSkill(skillId: string): Promise<boolean> {
  const rows = await db.delete(skills).where(eq(skills.id, skillId)).returning({ id: skills.id });
  return rows.length > 0;
}

export async function getSkill(skillId: string): Promise<Skill | undefined> {
  return (await db.select().from(skills).where(eq(skills.id, skillId)))[0];
}

// ---------- SKILL.md ----------
/** Minimal front-matter reader: `key: value`, quoted values, and `>`/`|` block scalars. Unknown keys are ignored. */
export function parseSkillMd(text: string): { name: string; description: string; body: string } {
  const m = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/);
  if (!m) throw new SkillError("SKILL.md must start with a --- front-matter block containing name and description", "invalid");
  const fm: Record<string, string> = {};
  const lines = m[1]!.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i]!.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(val) || val === "") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
      val = block.join(val.startsWith("|") ? "\n" : " ");
    } else if (/^(["']).*\1$/.test(val)) val = val.slice(1, -1);
    fm[kv[1]!.toLowerCase()] = val;
  }
  if (!fm.name || !fm.description) throw new SkillError("front matter needs both name and description", "invalid");
  return { name: fm.name, description: fm.description, body: (m[2] ?? "").trim() };
}

/** Parse + create a SKILL.md for `viewer`. `overwrite` replaces a same-named skill the viewer may manage (version bumps). */
export async function uploadSkill(a: { content: string; viewer: SkillViewer; scope: "org" | "user"; overwrite?: boolean }): Promise<Skill> {
  if (a.scope === "org" && !isAdmin(a.viewer)) throw new SkillError("only admins can upload org skills", "forbidden");
  const parsed = parseSkillMd(a.content);
  const [existing] = await db.select().from(skills).where(sql`lower(${skills.name}) = ${normName(squash(parsed.name))}`);
  if (existing && a.overwrite && canManageSkill(existing, a.viewer) && existing.scope === a.scope) return updateSkill(existing.id, parsed);
  return createSkill({ ...parsed, scope: a.scope, ownerUserId: a.scope === "user" ? a.viewer.userId : null, createdBy: a.viewer.userId });
}

// ---------- workspace prompt ----------
export async function getWorkspacePrompt(): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "workspace_prompt"));
  return typeof row?.value === "string" ? row.value : "";
}

export async function setWorkspacePrompt(prompt: string): Promise<string> {
  const value = prompt.trim();
  if (value.length > WORKSPACE_PROMPT_MAX) throw new SkillError(`prompt must be ${WORKSPACE_PROMPT_MAX} characters or fewer`, "invalid");
  await db.insert(settings).values({ key: "workspace_prompt", value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  return value;
}

// ---------- prompt section / loading ----------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const oneLine = (s: string) => {
  const l = (s.split("\n")[0] ?? "").trim();
  return l.length > INDEX_DESC_MAX ? l.slice(0, INDEX_DESC_MAX - 1) + "…" : l;
};

const visibleTo = (askerId?: string | null) =>
  and(eq(skills.enabled, true), askerId ? or(eq(skills.scope, "org"), eq(skills.ownerUserId, askerId)) : eq(skills.scope, "org"));

/**
 * Compact index (name + one short line) of enabled org skills plus the asker's own. "" when none.
 * Org skills come first and are identical for everyone, so the personal tail is the only per-user part.
 */
export async function skillsPromptSection(askerId?: string | null): Promise<string> {
  const rows = await db.select().from(skills).where(visibleTo(askerId));
  if (!rows.length) return "";
  const byName = (a: Skill, b: Skill) => a.name.localeCompare(b.name);
  const ordered = [...rows.filter((r) => r.scope === "org").sort(byName), ...rows.filter((r) => r.scope === "user").sort(byName)];
  return [
    "<available_skills>",
    "Load the closest relevant skill with load_skill before acting. Names are exact.",
    ...ordered.map((s) => `${esc(s.name)} — ${esc(oneLine(s.description))}${s.scope === "user" ? " (yours)" : ""}`),
    "</available_skills>",
  ].join("\n");
}

/** Body of an enabled skill the asker may see (their own wins), capped at LOAD_SKILL_MAX_CHARS. */
export async function loadSkill(name: string, askerId?: string | null): Promise<string | null> {
  const rows = await db.select().from(skills).where(and(visibleTo(askerId), sql`lower(${skills.name}) = ${normName(squash(name))}`));
  const row = rows.find((r) => r.scope === "user") ?? rows[0];
  if (!row) return null;
  return row.body.length > LOAD_SKILL_MAX_CHARS
    ? `${row.body.slice(0, LOAD_SKILL_MAX_CHARS)}\n[skill truncated: ${row.body.length - LOAD_SKILL_MAX_CHARS} more chars]`
    : row.body;
}

/** `load_skill` bound to the asker (so personal skills resolve). turn/tools.ts can spread this instead of its inline tool. */
export function skillTools(ctx: { userId: string | null }): ToolSet {
  return {
    load_skill: tool({
      description: "Load a skill's full instructions by exact name.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }) => (await loadSkill(name, ctx.userId)) ?? `No skill named "${name}".`,
    }),
  };
}

// ---------- built-ins ----------
const BUILTIN: SkillInput[] = [
  {
    name: "write-a-digest",
    description: "How to compile a short, scannable recap of recent activity (daily/weekly digests, status roundups).",
    body: [
      "# Writing a digest",
      "1. Pull from memory and read-only tools only; never invent items.",
      "2. Lead with the 1-3 things that need attention (blockers, decisions pending, unanswered questions).",
      "3. Then a short list of what changed, grouped by project or channel, each line: what happened, who owns it, next step/date if known.",
      "4. Skip empty sections. If nothing noteworthy happened, say so in one line.",
      "5. Keep it under ~15 lines of Slack mrkdwn. Link sources when you have them.",
    ].join("\n"),
  },
];

/** Inserts built-in skills once (settings flag), so an admin deleting one is not undone on reboot. */
export async function seedBuiltinSkills(): Promise<void> {
  const [flag] = await db.select().from(settings).where(eq(settings.key, "skills_seeded"));
  if (flag) return;
  for (const s of BUILTIN) {
    await assertNameFree(s.name).then(() => createSkill({ ...s, createdBy: "system" }), () => undefined);
  }
  await db.insert(settings).values({ key: "skills_seeded", value: true }).onConflictDoNothing();
}
