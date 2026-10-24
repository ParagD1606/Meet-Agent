import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z.string().default("postgres://brain:brain@localhost:5432/brain"),
  PUBLIC_URL: z.string().default("http://localhost:3000"),
  PORT: z.coerce.number().default(3000),
  ENCRYPTION_KEY: z.string().optional(),
  SLACK_MODE: z.enum(["socket", "http"]).default("socket"),
  MODEL_API_KEY: z.string().optional(),
  /** "vertex" runs chat and embeddings on Google Vertex AI with Application Default Credentials (no API key). */
  MODEL_PROVIDER: z.enum(["vertex"]).optional(),
  GOOGLE_VERTEX_PROJECT: z.string().optional(),
  GOOGLE_VERTEX_LOCATION: z.string().default("global"),
  GOOGLE_VERTEX_EMBED_LOCATION: z.string().default("us-central1"),
  GOOGLE_VERTEX_EMBED_MODEL: z.string().default("gemini-embedding-001"),
  MODEL_BASE_URL: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  /** OpenAI-compatible embeddings endpoint base (e.g. Ollama http://localhost:11434/v1). When set, EMBEDDING_API_KEY is optional. */
  EMBEDDING_BASE_URL: z.string().optional(),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_DIM: z.coerce.number().default(1536),
  MODEL_NAME: z.string().optional(),
  /** Path to the ADC JSON (authorized_user or service account). Read by google-auth-library for chat and embeddings. */
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  /** Pins this deployment to one Slack workspace (T...). Sign-in and install from any other team are refused. */
  SLACK_TEAM_ID: z.string().optional(),
  /** Optional fixed first-owner setup token. When unset a random one is generated per boot and printed to the log. */
  SETUP_TOKEN: z.string().optional(),
  SLACK_API_URL: z.string().optional(), // override https://slack.com/api/ (GovSlack, test doubles)
  SLACK_APP_TOKEN: z.string().optional(), // xapp- token, socket mode
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MS_CLIENT_ID: z.string().optional(),
  MS_CLIENT_SECRET: z.string().optional(),
  NOTION_CLIENT_ID: z.string().optional(),
  NOTION_CLIENT_SECRET: z.string().optional(),
  SEARCH_PROVIDER: z.enum(["tavily", "brave", "firecrawl"]).optional(),
  SEARCH_API_KEY: z.string().optional(),
  /** Post a one-time monthly message to the home channel when estimated model spend crosses this many USD. Alert only, never a cap. */
  MONTHLY_SPEND_ALERT_USD: z.coerce.number().positive().optional(),
  DB_POOL_MAX: z.coerce.number().int().min(2).default(20),
  /** Connections reserved for session-level advisory locks (one per running turn). Kept separate so locks can never starve queries. */
  DB_LOCK_POOL_MAX: z.coerce.number().int().min(2).default(25),
  /** Cross-provider fallback "provider:model" (the model_fallback setting wins). */
  MODEL_FALLBACK: z.string().optional(),
  FALLBACK_MODEL_API_KEY: z.string().optional(),
  FALLBACK_MODEL_BASE_URL: z.string().optional(),
  /** Boot default for memory cadence; the persisted memory_freshness setting wins. */
  MEMORY_FRESHNESS: z.enum(["normal", "fast"]).optional().catch(undefined),
});

export type Config = z.infer<typeof schema>;

/** pgvector hnsw/ivfflat indexes support at most 2000 dimensions. */
export const MAX_EMBEDDING_DIM = 2000;

/** Production invariants. Returns human-readable problems (empty = fine). Pure, so tests can feed any env. */
export function configProblems(c: Config, production = c.NODE_ENV === "production"): string[] {
  const p: string[] = [];
  if (c.EMBEDDING_DIM > MAX_EMBEDDING_DIM || c.EMBEDDING_DIM < 1) p.push(`EMBEDDING_DIM must be 1..${MAX_EMBEDDING_DIM} (pgvector index limit), got ${c.EMBEDDING_DIM}`);
  if (!production) return p;
  if (!c.ENCRYPTION_KEY) p.push("ENCRYPTION_KEY is required (32 random bytes, base64)");
  else if (Buffer.from(c.ENCRYPTION_KEY, "base64").length !== 32) p.push("ENCRYPTION_KEY must decode to exactly 32 bytes (base64)");
  if (!c.PUBLIC_URL.startsWith("https://")) p.push("PUBLIC_URL must be an https:// URL in production");
  if (c.SLACK_MODE === "http" && !c.SLACK_SIGNING_SECRET) p.push("SLACK_SIGNING_SECRET is required when SLACK_MODE=http");
  if (c.SLACK_MODE === "socket" && !c.SLACK_APP_TOKEN) p.push("SLACK_APP_TOKEN is required when SLACK_MODE=socket");
  if (c.MODEL_PROVIDER === "vertex" && (!c.GOOGLE_APPLICATION_CREDENTIALS || !c.GOOGLE_VERTEX_PROJECT)) {
    p.push("GOOGLE_APPLICATION_CREDENTIALS and GOOGLE_VERTEX_PROJECT are required when MODEL_PROVIDER=vertex");
  }
  if (!c.EMBEDDING_API_KEY && !c.EMBEDDING_BASE_URL && c.MODEL_PROVIDER !== "vertex") p.push("EMBEDDING_API_KEY is required unless EMBEDDING_BASE_URL is set");
  return p;
}

/** Throws one error listing every problem. Called at import in production; exported for tests/boot checks. */
export function assertConfig(c: Config, production?: boolean): void {
  const p = configProblems(c, production);
  if (p.length) throw new Error(`Invalid configuration:\n - ${p.join("\n - ")}`);
}

export const config = schema.parse(process.env);

/**
 * Tuning knobs. Parsed on every call (cheap) so tests and ops can change process.env without a restart of the module;
 * an invalid value falls back to the default rather than throwing mid-request.
 */
const flag = (def: boolean) => z.string().optional().transform((v) => (v === undefined || v === "" ? def : /^(1|true|on)$/i.test(v)));
const num = (def: number) => z.coerce.number().int().min(0).catch(def).default(def);
const tuningSchema = z.object({
  QUIET_HOURS: z.string().optional(),
  MEMORY_RERANK: flag(false),
  MEMORY_ENTITY_EXPANSION: z.string().optional(),
  MEMORY_AMBIENT_MAX_PER_HOUR: num(60),
  MEMORY_BACKFILL_CALLS_PER_RUN: num(20),
  MEMORY_BACKFILL_DAILY_CALLS: num(400),
  WEB_DIST: z.string().optional(),
});
export const tuningEnv = () => {
  const t = tuningSchema.parse(process.env);
  return { ...t, quietHoursForced: t.QUIET_HOURS === "1", entityExpansion: t.MEMORY_ENTITY_EXPANSION !== "0" };
};

/** True when a chat model is reachable by configuration: an API key, an OpenAI-compatible URL, or Vertex ADC. */
export const modelConfigured = (c: Config = config) => Boolean(c.MODEL_API_KEY || c.MODEL_BASE_URL || c.MODEL_PROVIDER === "vertex");
assertConfig(config);

/** Pass to Bun.serve({ ...serverOptions }) in index.ts. idleTimeout is seconds (max 255); body cap is bytes. */
export const serverOptions = {
  idleTimeout: 120,
  maxRequestBodySize: 32 * 1024 * 1024,
} as const;
