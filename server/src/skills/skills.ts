import { and, asc, eq, sql } from "drizzle-orm";
import { id as newId } from "../crypto";
import { db } from "../db";
import { settings, skills } from "../db/schema";

export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 200;
export const SKILL_BODY_MAX_BYTES = 16 * 1024;
export const SKILL_CAP = 100;
export const WORKSPACE_PROMPT_MAX = 8000;

export class SkillError extends Error {
  constructor(message: string, readonly code: "invalid" | "conflict" | "limit" | "not_found") {
    super(message);
  }
}

export type Skill = typeof skills.$inferSelect;
export type SkillInput = { name: string; description: string; body: string; enabled?: boolean; createdBy?: string | null };

const squash = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");
const normName = (s: string) => s.toLocaleLowerCase();

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

async function assertNameFree(name: string, exceptId?: string) {
  const rows = await db.select({ id: skills.id }).from(skills).where(sql`lower(${skills.name}) = ${normName(name)}`);
  if (rows.some((r) => r.id !== exceptId)) throw new SkillError("a skill with that name already exists", "conflict");
}

export const listSkills = (): Promise<Skill[]> => db.select().from(skills).orderBy(asc(skills.name));

export async function createSkill(input: SkillInput): Promise<Skill> {
  const v = validate(input);
  await assertNameFree(v.name);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(skills);
  if (n >= SKILL_CAP) throw new SkillError(`skill limit reached (${SKILL_CAP})`, "limit");
  const [row] = await db
    .insert(skills)
    .values({ id: newId("sk_"), ...v, enabled: input.enabled ?? true, createdBy: input.createdBy ?? null })
    .returning();
  return row!;
}

export async function updateSkill(skillId: string, patch: Partial<SkillInput>): Promise<Skill> {
  const [cur] = await db.select().from(skills).where(eq(skills.id, skillId));
  if (!cur) throw new SkillError("skill not found", "not_found");
  const v = validate({ name: cur.name, description: cur.description, body: cur.body, ...patch });
  await assertNameFree(v.name, skillId);
  const [row] = await db
    .update(skills)
    .set({ ...v, enabled: patch.enabled ?? cur.enabled })
    .where(eq(skills.id, skillId))
    .returning();
  return row!;
}

export async function deleteSkill(skillId: string): Promise<boolean> {
  const rows = await db.delete(skills).where(eq(skills.id, skillId)).returning({ id: skills.id });
  return rows.length > 0;
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

/** Name + description of enabled skills; "" when none. Body is fetched on demand via load_skill. */
export async function skillsPromptSection(): Promise<string> {
  const rows = await db.select().from(skills).where(eq(skills.enabled, true)).orderBy(asc(skills.name));
  if (!rows.length) return "";
  return [
    "<available_skills>",
    "If a skill is even partially relevant to the task, load the closest one with load_skill and follow it. Names are exact.",
    ...rows.map((s) => `${esc(s.name)} — ${esc(s.description)}`),
    "</available_skills>",
  ].join("\n");
}

export async function loadSkill(name: string): Promise<string | null> {
  const [row] = await db
    .select({ body: skills.body })
    .from(skills)
    .where(and(eq(skills.enabled, true), sql`lower(${skills.name}) = ${normName(squash(name))}`));
  return row?.body ?? null;
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
