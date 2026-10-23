import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z.string().default("postgres://brain:brain@localhost:5432/brain"),
  PUBLIC_URL: z.string().default("http://localhost:3000"),
  PORT: z.coerce.number().default(3000),
  ENCRYPTION_KEY: z.string().optional(),
  SLACK_MODE: z.enum(["socket", "http"]).default("socket"),
  MODEL_API_KEY: z.string().optional(),
  MODEL_BASE_URL: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  /** OpenAI-compatible embeddings endpoint base (e.g. Ollama http://localhost:11434/v1). When set, EMBEDDING_API_KEY is optional. */
  EMBEDDING_BASE_URL: z.string().optional(),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_DIM: z.coerce.number().default(1536),
  MODEL_NAME: z.string().optional(),
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
  DB_POOL_MAX: z.coerce.number().int().min(2).default(20),
  /** Connections reserved for session-level advisory locks (one per running turn). Kept separate so locks can never starve queries. */
  DB_LOCK_POOL_MAX: z.coerce.number().int().min(2).default(25),
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
  if (!c.EMBEDDING_API_KEY && !c.EMBEDDING_BASE_URL) p.push("EMBEDDING_API_KEY is required unless EMBEDDING_BASE_URL is set");
  return p;
}

/** Throws one error listing every problem. Called at import in production; exported for tests/boot checks. */
export function assertConfig(c: Config, production?: boolean): void {
  const p = configProblems(c, production);
  if (p.length) throw new Error(`Invalid configuration:\n - ${p.join("\n - ")}`);
}

export const config = schema.parse(process.env);
assertConfig(config);

/** Pass to Bun.serve({ ...serverOptions }) in index.ts. idleTimeout is seconds (max 255); body cap is bytes. */
export const serverOptions = {
  idleTimeout: 120,
  maxRequestBodySize: 32 * 1024 * 1024,
} as const;
