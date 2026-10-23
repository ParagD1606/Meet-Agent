// Deployment guards for the Vertex (ADC JSON only) setup: boot rules, provider selection, and the Gemini 3
// thought-signature round trip that used to fail every tool turn with "Function call is missing a thought_signature".
import "./env";
import { afterEach, describe, expect, test } from "bun:test";
import { createVertex } from "@ai-sdk/google-vertex";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { config, configProblems, modelConfigured, type Config } from "../../src/config";
import { detectProvider, getModel } from "../../src/llm";

const prod = (over: Partial<Config> = {}): Config => ({
  ...config,
  NODE_ENV: "production",
  PUBLIC_URL: "https://slack.example.com",
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  SLACK_MODE: "socket",
  SLACK_APP_TOKEN: "xapp-test",
  MODEL_PROVIDER: "vertex",
  GOOGLE_VERTEX_PROJECT: "my-project",
  GOOGLE_APPLICATION_CREDENTIALS: "/app/application_default_credentials.json",
  MODEL_API_KEY: undefined,
  MODEL_BASE_URL: undefined,
  EMBEDDING_API_KEY: undefined,
  EMBEDDING_BASE_URL: undefined,
  ...over,
});

describe("production boot with only the ADC JSON", () => {
  test("no model key, no embedding key: valid", () => {
    expect(configProblems(prod())).toEqual([]);
    expect(modelConfigured(prod())).toBe(true);
  });
  test("a missing credentials path or project is reported", () => {
    expect(configProblems(prod({ GOOGLE_APPLICATION_CREDENTIALS: undefined })).join()).toContain("GOOGLE_APPLICATION_CREDENTIALS");
    expect(configProblems(prod({ GOOGLE_VERTEX_PROJECT: undefined })).join()).toContain("GOOGLE_VERTEX_PROJECT");
  });
  test("non-vertex deployments still need an embedding key", () => {
    expect(configProblems(prod({ MODEL_PROVIDER: undefined, MODEL_API_KEY: "sk-x" })).join()).toContain("EMBEDDING_API_KEY");
  });
});

describe("provider selection", () => {
  const saved = { p: config.MODEL_PROVIDER, k: config.MODEL_API_KEY, u: config.MODEL_BASE_URL, proj: config.GOOGLE_VERTEX_PROJECT };
  afterEach(() => {
    config.MODEL_PROVIDER = saved.p; config.MODEL_API_KEY = saved.k; config.MODEL_BASE_URL = saved.u; config.GOOGLE_VERTEX_PROJECT = saved.proj;
  });
  test("vertex wins over a leftover MODEL_BASE_URL / MODEL_API_KEY", () => {
    config.MODEL_PROVIDER = "vertex";
    expect(detectProvider("sk-ant-leftover", "http://localhost:11434/v1")).toBe("vertex");
    expect(detectProvider(undefined, undefined)).toBe("vertex");
  });
  test("a saved 'google/<model>' id is accepted and sent as a bare model id", () => {
    config.MODEL_PROVIDER = "vertex"; config.GOOGLE_VERTEX_PROJECT = "my-project";
    const id = (getModel("main", "google/gemini-3.5-flash") as { modelId?: string }).modelId;
    expect(id).toBe("gemini-3.5-flash");
  });
});

describe("Gemini 3 thought signatures across tool steps (no network)", () => {
  const body = (parts: unknown[]) => JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 } });
  test("the signature on a replayed functionCall reaches the next request", async () => {
    const bodies: any[] = [];
    const urls: string[] = [];
    let n = 0;
    const fetchMock = (async (url: string, init: { body: string }) => {
      urls.push(String(url));
      bodies.push(JSON.parse(init.body));
      const first = n++ === 0;
      const parts = first ? [{ functionCall: { name: "people_search", args: { query: "parag" } }, thoughtSignature: "SIG-123" }] : [{ text: "Done." }];
      return new Response(body(parts), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const vertex = createVertex({ project: "my-project", location: "global", fetch: fetchMock, headers: async () => ({ authorization: "Bearer t" }) } as never);
    const res = await generateText({
      model: vertex("gemini-3.5-flash"),
      prompt: "tell parag about our company",
      tools: { people_search: tool({ description: "find people", inputSchema: z.object({ query: z.string() }), execute: async () => "Parag <@U1>" }) },
      stopWhen: stepCountIs(3),
    });
    expect(res.text).toBe("Done.");
    expect(urls[0]).toContain("/projects/my-project/locations/global/publishers/google/models/gemini-3.5-flash:");
    const replayed = JSON.stringify(bodies[1]);
    expect(replayed).toContain("SIG-123"); // without this Vertex answers 400 on every multi-step tool turn
  });
});
