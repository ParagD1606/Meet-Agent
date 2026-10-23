import { beforeEach, expect, test } from "bun:test";
import { db, resetDb } from "../db";
import { skills } from "../../src/db/schema";
import {
  SkillError, createSkill, deleteSkill, getWorkspacePrompt, listSkills, loadSkill, seedBuiltinSkills, setWorkspacePrompt,
  skillsPromptSection, updateSkill,
} from "../../src/skills/skills";

beforeEach(resetDb);
const base = { name: "Incident Report", description: "How to write one", body: "# Steps\n1. do it" };

test("crud round trip", async () => {
  const s = await createSkill({ ...base, createdBy: "U1" });
  expect(s.enabled).toBe(true);
  expect((await listSkills()).map((x) => x.name)).toEqual(["Incident Report"]);
  const u = await updateSkill(s.id, { description: "new desc", enabled: false });
  expect(u.description).toBe("new desc");
  expect(u.enabled).toBe(false);
  expect(u.body).toBe(base.body);
  expect(await deleteSkill(s.id)).toBe(true);
  expect(await deleteSkill(s.id)).toBe(false);
});

test("validation: required, lengths, case-insensitive duplicate, not found", async () => {
  const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as SkillError | null)?.code;
  expect(await code(createSkill({ ...base, name: "  " }))).toBe("invalid");
  expect(await code(createSkill({ ...base, description: "x".repeat(201) }))).toBe("invalid");
  expect(await code(createSkill({ ...base, body: "x".repeat(16 * 1024 + 1) }))).toBe("invalid");
  const s = await createSkill(base);
  expect(await code(createSkill({ ...base, name: "incident   report" }))).toBe("conflict");
  const other = await createSkill({ ...base, name: "Other" });
  expect(await code(updateSkill(other.id, { name: "INCIDENT REPORT" }))).toBe("conflict");
  expect(await updateSkill(s.id, { name: "incident report" })).toMatchObject({ name: "incident report" }); // self-rename ok
  expect(await code(updateSkill("nope", { body: "x" }))).toBe("not_found");
});

test("skill cap", async () => {
  await db.insert(skills).values(Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, name: `n${i}`, description: "d", body: "b" })));
  const err = await createSkill(base).catch((e) => e);
  expect(err).toBeInstanceOf(SkillError);
  expect(err.code).toBe("limit");
});

test("prompt section lists only enabled skills, escapes, and loadSkill is case-insensitive", async () => {
  expect(await skillsPromptSection()).toBe("");
  await createSkill({ name: "A <b>", description: "uses & stuff", body: "body-a" });
  const off = await createSkill({ name: "Hidden", description: "nope", body: "body-h", enabled: false });
  const section = await skillsPromptSection();
  expect(section).toContain("<available_skills>");
  expect(section).toContain("A &lt;b&gt; — uses &amp; stuff");
  expect(section).not.toContain("Hidden");
  expect(await loadSkill("a <B>")).toBe("body-a");
  expect(await loadSkill("hidden")).toBeNull();
  expect(await loadSkill("missing")).toBeNull();
  await updateSkill(off.id, { enabled: true });
  expect(await loadSkill("hidden")).toBe("body-h");
});

test("workspace prompt get/set/limit", async () => {
  expect(await getWorkspacePrompt()).toBe("");
  expect(await setWorkspacePrompt("  Be brief.  ")).toBe("Be brief.");
  expect(await getWorkspacePrompt()).toBe("Be brief.");
  expect(await setWorkspacePrompt("")).toBe("");
  expect(await getWorkspacePrompt()).toBe("");
  await expect(setWorkspacePrompt("x".repeat(8001))).rejects.toThrow();
});

test("built-in skill is seeded once, even after deletion", async () => {
  await seedBuiltinSkills();
  const [s] = await listSkills();
  expect(s?.name).toBe("write-a-digest");
  await deleteSkill(s!.id);
  await seedBuiltinSkills();
  expect(await listSkills()).toHaveLength(0);
});
