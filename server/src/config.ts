import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().default("postgres://brain:brain@localhost:5432/brain"),
  PUBLIC_URL: z.string().default("http://localhost:3000"),
  PORT: z.coerce.number().default(3000),
  ENCRYPTION_KEY: z.string().optional(),
  SLACK_MODE: z.enum(["socket", "http"]).default("socket"),
  MODEL_API_KEY: z.string().optional(),
  MODEL_BASE_URL: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_DIM: z.coerce.number().default(1536),
  MODEL_NAME: z.string().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
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
});

export const config = schema.parse(process.env);
export type Config = z.infer<typeof schema>;
