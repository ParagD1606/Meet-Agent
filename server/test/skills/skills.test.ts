import "../turn/env";
import { beforeEach, describe, expect, test } from "bun:test";
import { resetDb } from "../db";
import { db, pool } from "../../src/db";
import { memories, skills } from "../../src/db/schema";
import {
  LOAD_SKILL_MAX_CHARS, SkillError, createSkill, listSkills, loadSkill, parseSkillMd, skillTools, skillsPromptSection, updateSkill, uploadSkill,
} from "../../src/skills/skills";
import { memoriesToMarkdown, mountExportRoutes } from "../../src/routes/export";
import { mountSkillsUploadRoutes } from "../../src/routes/skills-upload";
import { api, call, login } from "../mcp/app";

mountSkillsUploadRoutes(api);
mountExportRoutes(api);
beforeEach(resetDb);

const MD = `---\nname: pdf-report\ndescription: "Build a PDF report"\nextra: ignored\n---\n# Steps\n1. go\n`;
const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as SkillError | null)?.code;

describe("SKILL.md parser", () => {
  test("front matter: plain, quoted, folded and literal block values; extra keys ignored", () => {
    expect(parseSkillMd(MD)).toEqual({ name: "pdf-report", description: "Build a PDF report", body: "# Steps\n1. go" });
    const p = parseSkillMd("---\nname: a\ndescription: >\n  first line\n  second line\n---\nbody");
    expect(p.description).toBe("first line second line");
    expect(parseSkillMd("﻿---\r\nname: a\r\ndescription: d\r\n---\r\nbody\r\n").body).toBe("body");
  });
  test("rejects missing front matter / name / description", () => {
    for (const bad of ["# no front matter", "---\nname: a\n---\nx", "---\ndescription: d\n---\nx"]) expect(() => parseSkillMd(bad)).toThrow(SkillError);
  });
});

describe("scopes and visibility", () => {
  test("prompt index shows org + own personal skills only, org first, compact and escaped", async () => {
    await createSkill({ name: "Org One", description: "line one", body: "b" });
    await createSkill({ name: "Mine", description: "x".repeat(150), body: "b", scope: "user", ownerUserId: "U1" });
    await createSkill({ name: "Theirs", description: "secret", body: "b", scope: "user", ownerUserId: "U2" });
    const s = await skillsPromptSection("U1");
    expect(s).toContain("Org One — line one");
    expect(s).toContain("Mine — ");
    expect(s).toContain("(yours)");
    expect(s).not.toContain("Theirs");
    expect(s.indexOf("Org One")).toBeLessThan(s.indexOf("Mine"));
    expect(s).not.toContain("x".repeat(101));
    expect(await skillsPromptSection()).not.toContain("Mine"); // anonymous/automation: org only
    // org part byte-identical for everyone (cache-stable prefix)
    expect((await skillsPromptSection("U2")).split("\n").slice(0, 3)).toEqual(s.split("\n").slice(0, 3));
  });

  test("load_skill: own personal visible, others' not; body capped", async () => {
    await createSkill({ name: "Mine", description: "d", body: "secret-body", scope: "user", ownerUserId: "U1" });
    expect(await loadSkill("mine", "U1")).toBe("secret-body");
    expect(await loadSkill("mine", "U2")).toBeNull();
    expect(await loadSkill("mine")).toBeNull();
    await db.insert(skills).values({ id: "big", name: "Big", description: "d", body: "z".repeat(LOAD_SKILL_MAX_CHARS + 100) });
    const out = (await loadSkill("big"))!;
    expect(out.length).toBeLessThan(LOAD_SKILL_MAX_CHARS + 80);
    expect(out).toContain("skill truncated: 100 more chars");
    const t: any = skillTools({ userId: "U1" });
    expect(await t.load_skill.execute({ name: "Mine" }, {})).toBe("secret-body");
  });

  test("personal skill requires an owner; per-user cap", async () => {
    expect(await code(createSkill({ name: "x", description: "d", body: "b", scope: "user" }))).toBe("invalid");
    for (let i = 0; i < 20; i++) await createSkill({ name: `s${i}`, description: "d", body: "b", scope: "user", ownerUserId: "U1" });
    expect(await code(createSkill({ name: "s21", description: "d", body: "b", scope: "user", ownerUserId: "U1" }))).toBe("limit");
    expect(await listSkills({ userId: "U2", role: "member" })).toHaveLength(0);
  });
});

describe("version lock", () => {
  test("every update bumps version; a stale expectedVersion conflicts and changes nothing", async () => {
    const s = await createSkill({ name: "A", description: "d", body: "b" });
    expect(s.version).toBe(1);
    const u = await updateSkill(s.id, { body: "b2" }, { expectedVersion: 1 });
    expect(u.version).toBe(2);
    expect(await code(updateSkill(s.id, { body: "b3" }, { expectedVersion: 1 }))).toBe("conflict");
    expect((await listSkills())[0]!.body).toBe("b2");
  });

  test("concurrent saves with the same version: exactly one wins", async () => {
    const s = await createSkill({ name: "A", description: "d", body: "b" });
    const r = await Promise.allSettled([updateSkill(s.id, { body: "x" }, { expectedVersion: 1 }), updateSkill(s.id, { body: "y" }, { expectedVersion: 1 })]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });
});

describe("upload + REST", () => {
  test("uploadSkill: members get personal skills, org needs admin, duplicate conflicts, overwrite bumps version", async () => {
    const member = { userId: "U1", role: "member" as const };
    const admin = { userId: "UA", role: "admin" as const };
    const s = await uploadSkill({ content: MD, viewer: member, scope: "user" });
    expect(s).toMatchObject({ scope: "user", ownerUserId: "U1", name: "pdf-report" });
    expect(await code(uploadSkill({ content: MD, viewer: member, scope: "org" }))).toBe("forbidden");
    expect(await code(uploadSkill({ content: MD, viewer: member, scope: "user" }))).toBe("conflict");
    const again = await uploadSkill({ content: MD.replace("go", "went"), viewer: member, scope: "user", overwrite: true });
    expect(again.id).toBe(s.id);
    expect(again.version).toBe(2);
    expect((await uploadSkill({ content: MD.replace("pdf-report", "org-one"), viewer: admin, scope: "org" })).scope).toBe("org");
  });

  test("POST /api/skills/upload (multipart and JSON) and size limit", async () => {
    const cookie = await login("U1");
    const form = new FormData();
    form.set("file", new File([MD], "SKILL.md"));
    const r = await call("POST", "/api/skills/upload", { cookie, form });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ name: "pdf-report", scope: "user", ownerUserId: "U1" });
    const j = await call("POST", "/api/skills/upload", { cookie, body: { content: MD.replace("pdf-report", "other") } });
    expect(j.status).toBe(201);
    const big = new FormData();
    big.set("file", new File(["x".repeat(70_000)], "SKILL.md"));
    expect((await call("POST", "/api/skills/upload", { cookie, form: big })).status).toBe(413);
    expect((await call("POST", "/api/skills/upload", { cookie, body: { content: "no front matter" } })).status).toBe(400);
    expect((await call("POST", "/api/skills/upload", { cookie, body: { content: MD, scope: "org" } })).status).toBe(403);
  });

  test("PUT requires expectedVersion (400), stale is 409 with currentVersion, scope rules on edit/delete/list", async () => {
    const owner = await login("U1");
    const other = await login("U2");
    const admin = await login("UA", "admin");
    const mine = await (await call("POST", "/api/skills", { cookie: owner, body: { name: "Mine", description: "d", body: "b" } })).json() as any;
    expect(mine).toMatchObject({ scope: "user", version: 1 });
    const org = await (await call("POST", "/api/skills", { cookie: admin, body: { name: "Org", description: "d", body: "b", scope: "org" } })).json() as any;
    expect((await call("POST", "/api/skills", { cookie: owner, body: { name: "Org2", description: "d", body: "b", scope: "org" } })).status).toBe(403);

    expect((await call("PUT", `/api/skills/${mine.id}`, { cookie: owner, body: { body: "new" } })).status).toBe(400);
    const ok = await call("PUT", `/api/skills/${mine.id}`, { cookie: owner, body: { body: "new", expectedVersion: 1 } });
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).version).toBe(2);
    const stale = await call("PUT", `/api/skills/${mine.id}`, { cookie: owner, body: { body: "newer", expectedVersion: 1 } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "conflict", currentVersion: 2 });

    // others cannot see or touch a personal skill, even admins
    expect((await call("PUT", `/api/skills/${mine.id}`, { cookie: other, body: { body: "x", expectedVersion: 2 } })).status).toBe(404);
    expect((await call("DELETE", `/api/skills/${mine.id}`, { cookie: admin })).status).toBe(404);
    // members cannot edit org skills
    expect((await call("PUT", `/api/skills/${org.id}`, { cookie: owner, body: { body: "x", expectedVersion: 1 } })).status).toBe(403);
    expect((await call("DELETE", `/api/skills/${org.id}`, { cookie: owner })).status).toBe(403);

    const list = async (c: string) => (await (await call("GET", "/api/skills", { cookie: c })).json()) as any[];
    expect((await list(owner)).map((s) => s.name).sort()).toEqual(["Mine", "Org"]);
    expect((await list(other)).map((s) => s.name)).toEqual(["Org"]);
    expect((await list(admin)).map((s) => s.name)).toEqual(["Org"]);
    expect((await call("DELETE", `/api/skills/${mine.id}`, { cookie: owner })).status).toBe(200);
  });
});

describe("memory export", () => {
  test("format: header, grouped by source with counts, one line per fact with date and ref", () => {
    const at = new Date("2026-01-02T00:00:00Z");
    const md = memoriesToMarkdown([
      { text: "Launch is\nMarch 3", source: "slack", sourceRef: null, permalink: "https://s/p1", createdAt: new Date("2026-01-01T10:00:00Z") },
      { text: "Doc fact", source: "notion", sourceRef: "page-9", permalink: null, createdAt: new Date("2026-01-01T10:00:00Z") },
    ], at);
    expect(md).toBe("# Company memory export\n\nExported 2026-01-02 · 2 shared facts\n\n## notion (1)\n\n- Doc fact _(2026-01-01, page-9)_\n\n## slack (1)\n\n- Launch is March 3 _(2026-01-01, https://s/p1)_\n");
  });

  test("GET /api/export/memories is admin-only and exports only active shared facts", async () => {
    const vec = `[${new Array(1536).fill(0).join(",")}]`;
    const ins = (scope: string, text: string, status = "active") =>
      pool.query("insert into memories (scope_tag, text, embedding, source, status) values ($1, $2, $3::vector, 'slack', $4)", [scope, text, vec, status]);
    await ins("shared", "public fact");
    await ins("channel_C9", "private fact");
    await ins("user_U1", "dm fact");
    await ins("shared", "old fact", "superseded");
    const member = await login("UM");
    const admin = await login("UA", "admin");
    expect((await call("GET", "/api/export/memories", { cookie: member })).status).toBe(403);
    const r = await call("GET", "/api/export/memories", { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/markdown");
    expect(r.headers.get("content-disposition")).toContain("attachment");
    const md = await r.text();
    expect(md).toContain("public fact");
    expect(md).not.toContain("private fact");
    expect(md).not.toContain("dm fact");
    expect(md).not.toContain("old fact");
  });
});
void memories;
