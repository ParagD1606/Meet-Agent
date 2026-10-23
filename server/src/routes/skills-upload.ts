import type { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../auth/session";
import { SkillError, canManageSkill, createSkill, deleteSkill, getSkill, listSkills, updateSkill, uploadSkill, type SkillViewer } from "../skills/skills";
import { codedError, httpError, readBody } from "./util";

const MAX_UPLOAD_BYTES = 64 * 1024;
const viewerOf = (u: AppEnv["Variables"]["user"]): SkillViewer => ({ userId: u.id, role: u.role });
const skillBody = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(32_000),
  enabled: z.boolean().optional(),
});

/**
 * Skills API with scopes + optimistic locking. Mount BEFORE `behavior` in buildApi (Hono answers with the first
 * matching handler) or delete the skills section of routes/behavior.ts; these routes replace it.
 *  GET /skills            org skills + your own personal ones
 *  POST /skills           {…, scope?: "org"|"user"}  (org needs admin; personal is yours)
 *  PUT /skills/:id        {…patch, expectedVersion}  409 {currentVersion} when stale
 *  DELETE /skills/:id     org: admin; personal: owner
 *  POST /skills/upload    multipart `file` (SKILL.md) or JSON {content}; scope, overwrite
 */
export function mountSkillsUploadRoutes(api: Hono<AppEnv>): void {
  api.get("/skills", requireAuth(), async (c) => c.json(await listSkills(viewerOf(c.get("user")))));

  api.post("/skills/upload", requireAuth(), async (c) => {
    const v = viewerOf(c.get("user"));
    let content: string, scope: string | undefined, overwrite = false;
    if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
      const form = await c.req.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) throw httpError(400, "invalid_body", { message: "attach a SKILL.md as `file`" });
      if (file.size > MAX_UPLOAD_BYTES) throw httpError(413, "too_large", { message: `SKILL.md must be ${MAX_UPLOAD_BYTES / 1024}KB or smaller` });
      content = await file.text();
      scope = form?.get("scope")?.toString();
      overwrite = form?.get("overwrite")?.toString() === "true";
    } else {
      const b = await readBody(c, z.object({ content: z.string().max(MAX_UPLOAD_BYTES), scope: z.enum(["org", "user"]).optional(), overwrite: z.boolean().optional() }));
      ({ content, scope, overwrite = false } = b);
    }
    const sc = scope === "org" ? "org" : scope === undefined || scope === "user" ? "user" : null;
    if (!sc) throw httpError(400, "invalid_body", { message: "scope must be org or user" });
    try { return c.json(await uploadSkill({ content, viewer: v, scope: sc, overwrite }), 201); } catch (e) { throw skillErr(e); }
  });

  api.post("/skills", requireAuth(), async (c) => {
    const u = c.get("user");
    const b = await readBody(c, skillBody.extend({ scope: z.enum(["org", "user"]).optional() }));
    const scope = b.scope ?? "user";
    if (scope === "org" && !(u.role === "admin" || u.role === "owner")) throw httpError(403, "forbidden");
    try { return c.json(await createSkill({ ...b, scope, ownerUserId: scope === "user" ? u.id : null, createdBy: u.id }), 201); } catch (e) { throw skillErr(e); }
  });

  api.put("/skills/:id", requireAuth(), async (c) => {
    const v = viewerOf(c.get("user"));
    const { expectedVersion, ...patch } = await readBody(c, skillBody.partial().extend({ expectedVersion: z.number().int().min(1) }));
    const cur = await getSkill(c.req.param("id"));
    if (!cur || (cur.scope === "user" && cur.ownerUserId !== v.userId)) throw httpError(404, "not_found");
    if (!canManageSkill(cur, v)) throw httpError(403, "forbidden");
    try { return c.json(await updateSkill(cur.id, patch, { expectedVersion })); } catch (e) { throw skillErr(e, cur.id); }
  });

  api.delete("/skills/:id", requireAuth(), async (c) => {
    const v = viewerOf(c.get("user"));
    const cur = await getSkill(c.req.param("id"));
    if (!cur || (cur.scope === "user" && cur.ownerUserId !== v.userId)) throw httpError(404, "not_found");
    if (!canManageSkill(cur, v)) throw httpError(403, "forbidden");
    await deleteSkill(cur.id);
    return c.json({ ok: true });
  });
}

/** 409s on a stale version carry the current version so the UI can reload and retry. */
function skillErr(e: unknown, id?: string) {
  if (e instanceof SkillError && e.code === "conflict" && id && /version|changed/.test(e.message)) {
    const m = e.message.match(/version (\d+)/);
    return httpError(409, "conflict", { message: e.message, ...(m ? { currentVersion: Number(m[1]) } : {}) });
  }
  return codedError(e);
}
