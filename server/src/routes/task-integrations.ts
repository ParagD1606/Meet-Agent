import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../auth/session";
import { recentPushes } from "../export/push";
import { githubCredential } from "../integrations/github-auth";
import { githubPublic, githubReady, REPO_RE, saveGithub, testGithub } from "../integrations/github-issues";
import { listRepos } from "../integrations/github-repos";
import { suggestMapping } from "../integrations/github-suggest";
import { getTrello, saveTrello, testTrello, trelloBoards, trelloLists, trelloMembers, trelloPublic } from "../integrations/trello";
import { IntegrationError } from "../integrations/types";
import { httpError, readBody } from "./util";

export const taskIntegrationRoutes = new Hono<AppEnv>();

/** Upstream failures become API errors that never carry a 401 (the web client treats 401 as "signed out"). */
const fail = (e: unknown) => {
  if (!(e instanceof IntegrationError)) throw e;
  const status = ({ not_configured: 409, unauthorized: 502, rate_limited: 429, not_found: 404, invalid: 400, upstream: 502 } as const)[e.code];
  return httpError(status, e.code === "unauthorized" ? "credentials_rejected" : e.code, { message: e.message, ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) });
};
const guard = async <T>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { throw fail(e); } };
const idStr = z.string().trim().regex(/^[\w-]{1,64}$/);
const map = z.record(z.string().regex(/^[\w-]{1,40}$/), z.string().trim().regex(/^[\w.-]{1,64}$/)).default({});

/** Which boards are ready, so every member's Send menu can hide the ones that are not (no settings, no secrets). */
taskIntegrationRoutes.get("/integrations/targets", requireAuth(), async (c) => c.json({ trello: !!(await getTrello())?.listId, github: await githubReady() }));

// ---------- Trello ----------
taskIntegrationRoutes.get("/settings/integrations/trello", requireAuth("admin"), async (c) => c.json(await trelloPublic()));
taskIntegrationRoutes.put("/settings/integrations/trello", requireAuth("admin"), async (c) => {
  const b = await readBody(c, z.object({ key: z.string().trim().regex(/^[\w-]{8,100}$/).optional(), token: z.string().trim().regex(/^[\w-]{8,200}$/).optional(), boardId: idStr.or(z.literal("")).default(""), listId: idStr.or(z.literal("")).default(""), memberMap: map }));
  await guard(() => saveTrello(b));
  return c.json(await trelloPublic());
});
/** Validates credentials (body overrides the stored ones) with GET /members/me. Creates nothing. */
taskIntegrationRoutes.post("/settings/integrations/trello/test", requireAuth("admin"), async (c) => {
  const b = await readBody(c, z.object({ key: z.string().trim().max(100).optional(), token: z.string().trim().max(200).optional() }));
  const stored = await getTrello();
  const key = b.key || stored?.key, token = b.token || stored?.token;
  if (!key || !token) throw httpError(409, "not_configured", { message: "Enter the API key and token first" });
  try { return c.json({ ok: true, ...(await testTrello({ key, token })) }); }
  catch (e) { const err = fail(e); return c.json({ ok: false, message: (e as Error).message }, err.status === 429 ? 429 : 200); }
});
taskIntegrationRoutes.get("/integrations/trello/boards", requireAuth("admin"), async (c) => c.json({ boards: await guard(trelloBoards) }));
taskIntegrationRoutes.get("/integrations/trello/boards/:id/lists", requireAuth("admin"), async (c) => c.json({ lists: await guard(() => trelloLists(c.req.param("id"))) }));
taskIntegrationRoutes.get("/integrations/trello/boards/:id/members", requireAuth("admin"), async (c) => c.json({ members: await guard(() => trelloMembers(c.req.param("id"))) }));

// ---------- GitHub Issues ----------
const login = z.string().trim().regex(/^[\w.-]{1,64}$/);
taskIntegrationRoutes.get("/settings/integrations/github-issues", requireAuth("admin"), async (c) => c.json(await githubPublic()));
taskIntegrationRoutes.put("/settings/integrations/github-issues", requireAuth("admin"), async (c) => {
  const b = await readBody(c, z.object({
    repo: z.string().trim().regex(REPO_RE).max(140), token: z.string().trim().min(8).max(300).optional(), usePat: z.boolean().optional(), assigneeMap: map,
    labels: z.array(z.string().trim().min(1).max(50)).max(10).default(["pixel"]),
    milestone: z.number().int().positive().nullable().optional(),
    projectOwner: login.or(z.literal("")).optional(), projectNumber: z.number().int().positive().nullable().optional(),
  }));
  await guard(() => saveGithub(b));
  return c.json(await githubPublic());
});
/** Checks the credential, repo, Issues access, app permissions and (when set) the project. Body values override the stored ones. Creates nothing. */
taskIntegrationRoutes.post("/settings/integrations/github-issues/test", requireAuth("admin"), async (c) => {
  const b = await readBody(c, z.object({ repo: z.string().trim().max(140).optional(), token: z.string().trim().max(300).optional(), projectOwner: z.string().trim().max(100).optional(), projectNumber: z.number().int().positive().nullable().optional() }));
  const stored = await githubPublic();
  const repo = b.repo || stored.repo;
  if (!repo) throw httpError(409, "not_configured", { message: "Pick a repository first" });
  const pOwner = b.projectOwner ?? stored.projectOwner, pNum = b.projectNumber === undefined ? stored.projectNumber : b.projectNumber;
  try {
    return c.json(await testGithub({ repo, cred: await githubCredential(repo, { pat: b.token || undefined }), project: pOwner && pNum ? { owner: pOwner, number: pNum } : undefined }));
  } catch (e) { const err = fail(e); return c.json({ ok: false, message: (e as Error).message }, err.status === 429 ? 429 : 200); }
});
/** Repos the connection can access (installation repositories, or the token's repos), searchable and paginated. */
taskIntegrationRoutes.get("/integrations/github/repos", requireAuth("admin"), async (c) =>
  c.json(await guard(() => listRepos({ q: c.req.query("q"), page: Number(c.req.query("page")) || 1, size: Number(c.req.query("size")) || 30 }))));
/** Assignable GitHub logins of a repo + suggested Slack-user -> login matches (email, login, name). */
taskIntegrationRoutes.get("/integrations/github/suggestions", requireAuth("admin"), async (c) => {
  const repo = c.req.query("repo") ?? "";
  if (!REPO_RE.test(repo)) throw httpError(400, "invalid", { message: "repo must look like owner/name" });
  return c.json(await guard(() => suggestMapping(repo)));
});

/** Audit of pushes (admin): who sent what where, and what failed. */
taskIntegrationRoutes.get("/integrations/pushes", requireAuth("admin"), async (c) => c.json({ pushes: await recentPushes(Math.min(Number(c.req.query("limit")) || 50, 200)) }));
