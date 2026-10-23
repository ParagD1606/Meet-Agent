import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { generateText, type LanguageModel, type SystemModelMessage } from "ai";
import { config } from "./config";

/** Legacy profiles stay valid: fast -> cheap roles, thorough -> main. */
export type ModelProfile = "fast" | "thorough";
export type ModelRole = "main" | "triage" | "extract" | "summarize" | "research";
export const MODEL_ROLES: ModelRole[] = ["main", "triage", "extract", "summarize", "research"];
type ProviderName = "anthropic" | "openai" | "google" | "xai";

const DEFAULTS = {
  anthropic: { fast: "claude-haiku-4-5", thorough: "claude-sonnet-4-5" },
  openai: { fast: "gpt-4.1-mini", thorough: "gpt-4.1" },
  google: { fast: "gemini-2.5-flash", thorough: "gemini-2.5-pro" },
  xai: { fast: "grok-3-mini", thorough: "grok-4" },
} as const;

/** Provider is inferred from the key prefix; MODEL_BASE_URL forces OpenAI-compatible (OpenRouter, Ollama). */
export function detectProvider(key: string | undefined, baseUrl?: string): keyof typeof DEFAULTS | "compat" {
  if (baseUrl) return "compat";
  if (!key) throw new Error("MODEL_API_KEY is not set");
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("AIza")) return "google";
  if (key.startsWith("xai-")) return "xai";
  return "openai";
}

const profileOf = (r: ModelRole | ModelProfile): ModelProfile =>
  r === "main" || r === "research" || r === "thorough" ? "thorough" : "fast";

// Admin-chosen settings (written by routes/settings). Refreshed on boot and every 30s.
let chosen: { profile: ModelProfile | null; model: string | null; roles: Partial<Record<ModelRole, string>>; fallback: string | null } =
  { profile: null, model: null, roles: {}, fallback: null };

export async function refreshModelSettings(): Promise<void> {
  const { db } = await import("./db");
  const { settings } = await import("./db/schema");
  const { inArray } = await import("drizzle-orm");
  const keys = ["model_profile", "model_override", "model_fallback", ...MODEL_ROLES.map((r) => `model_role_${r}`)];
  const rows = await db.select().from(settings).where(inArray(settings.key, keys));
  const v = (k: string) => rows.find((r) => r.key === k)?.value;
  const profile = v("model_profile");
  const model = v("model_override");
  const roles: Partial<Record<ModelRole, string>> = {};
  for (const r of MODEL_ROLES) {
    const x = v(`model_role_${r}`);
    if (typeof x === "string" && x.trim()) roles[r] = x.trim();
  }
  const fb = v("model_fallback");
  chosen = {
    profile: profile === "fast" || profile === "thorough" ? profile : null,
    model: typeof model === "string" && model ? model : null,
    roles,
    fallback: typeof fb === "string" && fb.trim() ? fb.trim() : null,
  };
}

/** Test seam: set role/fallback choices without a DB round trip. */
export function setModelChoicesForTest(c: Partial<typeof chosen>): void {
  chosen = { ...chosen, ...c };
}

function build(provider: ProviderName | "compat", name: string, key: string | undefined, baseURL?: string): LanguageModel {
  switch (provider) {
    case "compat": return createOpenAI({ apiKey: key ?? "none", baseURL }).chat(name);
    case "anthropic": return createAnthropic({ apiKey: key })(name);
    case "openai": return createOpenAI({ apiKey: key })(name);
    case "google": return createGoogleGenerativeAI({ apiKey: key })(name);
    case "xai": return createXai({ apiKey: key })(name);
  }
}

let testModel: ((role: ModelRole | ModelProfile, fallback: boolean) => LanguageModel | undefined) | undefined;
/** Test seam: return a mock model per role (and for the fallback attempt). */
export function setModelResolverForTest(f?: typeof testModel): void { testModel = f; }

/**
 * Model for a role. Resolution: explicit `override` > `model_role_<role>` setting > legacy admin override (main only)
 * > provider default for the role's tier. "fast"/"thorough" are accepted for old call sites.
 */
export function getModel(requested: ModelRole | ModelProfile = "main", override?: string): LanguageModel {
  const t = testModel?.(requested, false);
  if (t) return t;
  const tier = profileOf(requested);
  // cheap roles stay cheap; the admin profile only upgrades/downgrades main/research.
  const profile = tier === "fast" ? "fast" : (chosen.profile ?? "thorough");
  const roleSetting = (MODEL_ROLES as string[]).includes(requested) ? chosen.roles[requested as ModelRole] : undefined;
  override ??= roleSetting ?? (requested === "main" || requested === "thorough" ? (chosen.model ?? undefined) : undefined);
  const key = config.MODEL_API_KEY;
  const provider = detectProvider(key, config.MODEL_BASE_URL);
  if (provider === "compat") {
    const m = override ?? process.env.MODEL_NAME;
    if (!m) throw new Error("MODEL_NAME is required with MODEL_BASE_URL");
    return build("compat", m, key, config.MODEL_BASE_URL);
  }
  return build(provider, override ?? DEFAULTS[provider][profile], key);
}

/**
 * Cross-provider fallback model from the `model_fallback` setting, "provider:model" (provider = anthropic|openai|google|xai|compat).
 * Keys come from <PROVIDER>_API_KEY, else FALLBACK_MODEL_API_KEY; compat uses FALLBACK_MODEL_BASE_URL. Null when unset.
 */
export function getFallbackModel(role: ModelRole | ModelProfile = "main"): LanguageModel | null {
  const t = testModel?.(role, true);
  if (t) return t;
  const spec = chosen.fallback ?? process.env.MODEL_FALLBACK ?? null;
  if (!spec) return null;
  const i = spec.indexOf(":");
  const provider = (i > 0 ? spec.slice(0, i) : "") as ProviderName | "compat";
  const model = i > 0 ? spec.slice(i + 1) : spec;
  if (!["anthropic", "openai", "google", "xai", "compat"].includes(provider) || !model) return null;
  const envKey = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GOOGLE_GENERATIVE_AI_API_KEY", xai: "XAI_API_KEY", compat: "" }[provider];
  const key = (envKey && process.env[envKey]) || process.env.FALLBACK_MODEL_API_KEY;
  if (!key && provider !== "compat") return null;
  return build(provider, model, key, process.env.FALLBACK_MODEL_BASE_URL);
}

/** Network-ish failures worth retrying on another provider: timeouts, 429, 5xx. Never user aborts or 4xx request errors. */
export function isRetriableModelError(e: unknown): boolean {
  const err = e as { name?: string; statusCode?: number; status?: number; isRetryable?: boolean; message?: string } | null;
  if (!err) return false;
  if (err.name === "AbortError") return false;
  if (err.name === "TimeoutError") return true;
  const status = err.statusCode ?? err.status;
  if (typeof status === "number") return status === 429 || status >= 500 || status === 408;
  if (err.isRetryable) return true;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|timeout|overloaded|socket/i.test(err.message ?? "");
}

/** Runs `fn` with the role's model; on a retriable provider failure retries once on the fallback model (if configured). */
export async function withFallback<T>(role: ModelRole | ModelProfile, fn: (model: LanguageModel) => Promise<T>): Promise<T> {
  try {
    return await fn(getModel(role));
  } catch (e) {
    if (!isRetriableModelError(e)) throw e;
    const fb = getFallbackModel(role);
    if (!fb) throw e;
    const { log } = await import("./log");
    log.warn("model failed, using fallback", { role, err: String(e).slice(0, 200) });
    return fn(fb);
  }
}

// ---------- cost ----------
// USD per million tokens: [input, output, cacheRead, cacheWrite]. Local/unknown models cost 0.
const COST: [prefix: string, p: [number, number, number, number]][] = [
  ["claude-haiku-4", [1, 5, 0.1, 1.25]],
  ["claude-sonnet-4", [3, 15, 0.3, 3.75]],
  ["claude-opus-4", [15, 75, 1.5, 18.75]],
  ["gpt-4.1-mini", [0.4, 1.6, 0.1, 0.4]],
  ["gpt-4.1", [2, 8, 0.5, 2]],
  ["gpt-4o-mini", [0.15, 0.6, 0.075, 0.15]],
  ["gpt-4o", [2.5, 10, 1.25, 2.5]],
  ["gemini-2.5-flash", [0.3, 2.5, 0.075, 0.3]],
  ["gemini-2.5-pro", [1.25, 10, 0.31, 1.25]],
  ["grok-3-mini", [0.3, 0.5, 0.075, 0.3]],
  ["grok-4", [3, 15, 0.75, 3]],
];

export type Usage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };

/** Estimated USD*1e6 for one call. `inputTokens` is the SDK total (cache reads/writes are subsets of it). */
export function estimateCostMicros(model: string | { modelId?: string }, usage: Usage): number {
  const id = (typeof model === "string" ? model : model.modelId ?? "").toLowerCase().split("/").pop() ?? "";
  const row = COST.find(([p]) => id.startsWith(p));
  if (!row) return 0;
  const [pin, pout, pread, pwrite] = row[1];
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, (usage.inputTokens ?? 0) - read - write);
  // $/Mtok * tokens = micro-dollars exactly
  return Math.round(fresh * pin + read * pread + write * pwrite + (usage.outputTokens ?? 0) * pout);
}

/** Cheap liveness check of a role's model (used by /readyz and the setup wizard). */
export async function probeModel(role: ModelRole | ModelProfile = "main", timeoutMs = 15_000): Promise<{ ok: boolean; model: string; ms: number; error?: string }> {
  const t0 = Date.now();
  let model = "unknown";
  try {
    const m = getModel(role);
    model = (m as { modelId?: string }).modelId ?? "unknown";
    await generateText({ model: m, prompt: "Reply with the single word: ok", maxOutputTokens: 8, abortSignal: AbortSignal.timeout(timeoutMs) });
    return { ok: true, model, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, model, ms: Date.now() - t0, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

// ---------- prompt caching ----------
export type SystemBlock = { text: string; /** put an Anthropic cache breakpoint after this block */ cache?: boolean };

/**
 * System prompt as separate messages so Anthropic gets `cache_control` breakpoints (max 4, last ones win). Other providers
 * ignore providerOptions.anthropic and just see the same byte-stable text in the same order.
 */
export function cachedSystem(blocks: SystemBlock[]): SystemModelMessage[] {
  const flagged = blocks.map((b, i) => (b.cache ? i : -1)).filter((i) => i >= 0).slice(-4);
  return blocks.filter((b) => b.text).map((b) => {
    const idx = blocks.indexOf(b);
    return flagged.includes(idx)
      ? { role: "system" as const, content: b.text, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
      : { role: "system" as const, content: b.text };
  });
}
