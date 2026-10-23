import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import { config } from "./config";

export type ModelProfile = "fast" | "thorough";

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

// Admin-chosen profile/model (settings keys written by routes/settings). Refreshed on boot and every 30s.
let chosen: { profile: ModelProfile | null; model: string | null } = { profile: null, model: null };

export async function refreshModelSettings(): Promise<void> {
  const { db } = await import("./db");
  const { settings } = await import("./db/schema");
  const { inArray } = await import("drizzle-orm");
  const rows = await db.select().from(settings).where(inArray(settings.key, ["model_profile", "model_override"]));
  const v = (k: string) => rows.find((r) => r.key === k)?.value;
  const profile = v("model_profile");
  const model = v("model_override");
  chosen = {
    profile: profile === "fast" || profile === "thorough" ? profile : null,
    model: typeof model === "string" && model ? model : null,
  };
}

export function getModel(requested: ModelProfile = "thorough", override?: string): LanguageModel {
  // "fast" call sites (triage, extraction) stay fast; the admin profile only upgrades/downgrades "thorough" ones.
  const profile = requested === "fast" ? "fast" : (chosen.profile ?? requested);
  override ??= requested === "thorough" ? (chosen.model ?? undefined) : undefined;
  const key = config.MODEL_API_KEY;
  const provider = detectProvider(key, config.MODEL_BASE_URL);
  if (provider === "compat") {
    const m = override ?? process.env.MODEL_NAME;
    if (!m) throw new Error("MODEL_NAME is required with MODEL_BASE_URL");
    return createOpenAI({ apiKey: key ?? "none", baseURL: config.MODEL_BASE_URL }).chat(m);
  }
  const name = override ?? DEFAULTS[provider][profile];
  switch (provider) {
    case "anthropic": return createAnthropic({ apiKey: key })(name);
    case "openai": return createOpenAI({ apiKey: key })(name);
    case "google": return createGoogleGenerativeAI({ apiKey: key })(name);
    case "xai": return createXai({ apiKey: key })(name);
  }
}
