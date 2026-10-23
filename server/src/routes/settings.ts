import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../auth/session";
import { config } from "../config";
import { db } from "../db";
import { channels, settings } from "../db/schema";
import { detectProvider } from "../llm";
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

// ---------- proactivity ----------
const MODES = ["default", "proactive", "quiet"] as const;

async function proactivity() {
  const raw = await getSetting("proactivity_default");
  const chans = await db.select({ id: channels.id, name: channels.name, mode: channels.proactivity })
    .from(channels).where(eq(channels.isIm, false)).orderBy(channels.name);
  return { default: raw === "own" ? "own" : "all", channels: chans };
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
  return {
    provider: p,
    profile,
    model: typeof override === "string" ? override : null,
    models: p ? MODELS[p]! : [],
    freeText: p === "compat",
  };
}

settingsRoutes.get("/settings/models", requireAuth(), async (c) => c.json(await models()));
settingsRoutes.put("/settings/models", requireAuth("admin"), async (c) => {
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
  return c.json(await models());
});
