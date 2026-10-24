import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../auth/session";
import { config } from "../config";
import { db } from "../db";
import { channels, settings } from "../db/schema";
import { ACTION_CLASSES, getApprovalCards, setApprovalCards } from "../mcp/policy";
import { detectProvider, MODEL_ROLES, refreshModelSettings, type ModelRole } from "../llm";
import { getWorkspacePrompt, setWorkspacePrompt, WORKSPACE_PROMPT_MAX } from "../skills/skills";
import { httpError, readBody, codedError } from "./util";

export const settingsRoutes = new Hono<AppEnv>();

const getSetting = async (key: string) => (await db.select().from(settings).where(eq(settings.key, key)))[0]?.value;
const putSetting = (key: string, value: unknown) =>
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });

// ---------- workspace prompt ----------
settingsRoutes.get("/settings/workspace-prompt", requireAuth(), async (c) => c.json({ prompt: await getWorkspacePrompt() }));
settingsRoutes.put("/settings/workspace-prompt", requireAuth("admin"), async (c) => {
  const { prompt } = await readBody(c, z.object({ prompt: z.string().max(WORKSPACE_PROMPT_MAX) }));
  try {
    return c.json({ prompt: await setWorkspacePrompt(prompt) });
  } catch (e) { throw codedError(e); }
});

// ---------- approval cards per action class (default: none; deletes and unclassified actions always get one) ----------
settingsRoutes.get("/settings/approvals", requireAuth("admin"), async (c) => c.json({ cards: await getApprovalCards(), classes: ACTION_CLASSES }));
settingsRoutes.put("/settings/approvals", requireAuth("admin"), async (c) => {
  const body = await readBody(c, z.object({ cards: z.object(Object.fromEntries(ACTION_CLASSES.map((k) => [k, z.boolean().optional()]))) }));
  return c.json({ cards: await setApprovalCards(body.cards), classes: ACTION_CLASSES });
});

// ---------- proactivity ----------
const MODES = ["default", "proactive", "quiet"] as const;

async function proactivity() {
  const raw = await getSetting("proactivity_default");
  const chans = await db.select({ id: channels.id, name: channels.name, mode: channels.proactivity })
    .from(channels).where(eq(channels.isIm, false)).orderBy(channels.name);
  return { default: raw === "all" ? "all" : "own", channels: chans };
}

settingsRoutes.get("/settings/proactivity", requireAuth("admin"), async (c) => c.json(await proactivity()));
settingsRoutes.put("/settings/proactivity", requireAuth("admin"), async (c) => {
  const body = await readBody(c, z.object({
    default: z.enum(["all", "own"]),
    channels: z.array(z.object({ id: z.string().min(1).max(40), mode: z.enum(MODES) })).max(2000).default([]),
  }));
  await putSetting("proactivity_default", body.default);
  for (const mode of MODES) {
    const ids = body.channels.filter((ch) => ch.mode === mode).map((ch) => ch.id);
    if (ids.length) await db.update(channels).set({ proactivity: mode }).where(inArray(channels.id, ids));
  }
  return c.json(await proactivity());
});

// ---------- models ----------
// Static per provider: the provider is detected from the key prefix (see llm.ts), never fetched live.
const MODELS: Record<string, { id: string; label: string; profile: "fast" | "thorough" }[]> = {
  anthropic: [
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", profile: "fast" },
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", profile: "thorough" },
    { id: "claude-opus-4-1", label: "Claude Opus 4.1", profile: "thorough" },
  ],
  openai: [
    { id: "gpt-4.1-mini", label: "GPT-4.1 mini", profile: "fast" },
    { id: "gpt-4.1", label: "GPT-4.1", profile: "thorough" },
    { id: "gpt-5-mini", label: "GPT-5 mini", profile: "fast" },
    { id: "gpt-5", label: "GPT-5", profile: "thorough" },
  ],
  google: [
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", profile: "fast" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", profile: "thorough" },
  ],
  vertex: [
    { id: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (Vertex AI)", profile: "fast" },
    { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash (Vertex AI)", profile: "thorough" },
  ],
  xai: [
    { id: "grok-3-mini", label: "Grok 3 mini", profile: "fast" },
    { id: "grok-4", label: "Grok 4", profile: "thorough" },
  ],
  compat: [], // OpenAI-compatible base URL: the model is whatever MODEL_NAME / the override names
};

function provider(): string | null {
  try { return detectProvider(config.MODEL_API_KEY, config.MODEL_BASE_URL); } catch { return null; }
}

async function models() {
  const p = provider();
  const profile = (await getSetting("model_profile")) === "fast" ? "fast" : "thorough";
  const override = await getSetting("model_override");
  const roles: Record<string, string | null> = {};
  for (const r of MODEL_ROLES) {
    const v = await getSetting(`model_role_${r}`);
    roles[r] = typeof v === "string" && v ? v : null;
  }
  const fb = await getSetting("model_fallback");
  return {
    provider: p,
    roles,
    fallback: typeof fb === "string" && fb ? fb : null,
    profile,
    model: typeof override === "string" ? override : null,
    models: p ? MODELS[p]! : [],
    freeText: p === "compat",
  };
}

settingsRoutes.get("/settings/models", requireAuth(), async (c) => c.json(await models()));
settingsRoutes.put("/settings/models", requireAuth("admin"), async (c) => {
  const raw = await c.req.raw.clone().json().catch(() => null) as Record<string, unknown> | null;
  if (raw && ("role" in raw || "fallback" in raw)) {
    const b = await readBody(c, z.object({
      role: z.enum(MODEL_ROLES as [ModelRole, ...ModelRole[]]).optional(),
      model: z.string().trim().max(120).nullish(),
      fallback: z.string().trim().max(160).nullish(),
    }));
    if (b.role) await putSetting(`model_role_${b.role}`, b.model || null);
    if ("fallback" in raw) {
      if (b.fallback && !/^(anthropic|openai|google|xai|compat):.+/.test(b.fallback)) throw httpError(400, "bad_fallback");
      await putSetting("model_fallback", b.fallback || null);
    }
    await refreshModelSettings();
    return c.json(await models());
  }
  const body = await readBody(c, z.object({
    profile: z.enum(["fast", "thorough"]),
    provider: z.string().max(40).optional(),
    model: z.string().trim().min(1).max(120).nullish(),
  }));
  const p = provider();
  if (!p) throw httpError(400, "model_not_configured");
  if (body.provider && body.provider !== p) throw httpError(400, "provider_mismatch", { provider: p });
  if (body.model && p !== "compat" && !MODELS[p]!.some((m) => m.id === body.model)) throw httpError(400, "unknown_model");
  await putSetting("model_profile", body.profile);
  await putSetting("model_override", body.model ?? null);
  await refreshModelSettings();
  return c.json(await models());
});
