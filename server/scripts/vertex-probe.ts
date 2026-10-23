// Live check of the Vertex setup with the real ADC JSON (a few tiny billable calls). Prints no secrets.
//   cd server && set -a && . ../.env && set +a && bun scripts/vertex-probe.ts [model ...]
// On the VM: docker compose ... exec app bun server/scripts/vertex-probe.ts gemini-3.5-flash
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { config } from "../src/config";
import { embed } from "../src/memory/embed";
import { detectProvider, getModel } from "../src/llm";

const models = process.argv.slice(2).length ? process.argv.slice(2) : [undefined];
console.log("provider:", detectProvider(config.MODEL_API_KEY, config.MODEL_BASE_URL), "| location:", config.GOOGLE_VERTEX_LOCATION, "| creds file set:", Boolean(config.GOOGLE_APPLICATION_CREDENTIALS));
let failed = 0;
const step = async (name: string, f: () => Promise<string>) => {
  const t = Date.now();
  try { const out = await f(); console.log(`ok   ${name} (${Date.now() - t}ms): ${out}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${(e instanceof Error ? e.message : String(e)).slice(0, 400)}`); }
};

for (const m of models) {
  const model = getModel("main", m);
  const label = (model as { modelId?: string }).modelId ?? "?";
  await step(`chat ${label}`, async () => (await generateText({ model, prompt: "Reply with the single word: ok", maxOutputTokens: 128 })).text.trim());
  await step(`multi-step tool call ${label}`, async () => {
    const calls: string[] = [];
    const res = await generateText({
      model,
      prompt: "Use people_search to look up 'parag', then use company_info to get our company description, then answer in one sentence.",
      tools: {
        people_search: tool({ description: "Find teammates by name.", inputSchema: z.object({ query: z.string() }), execute: async ({ query }) => { calls.push("people_search"); return `Parag (${query}) <@U1>`; } }),
        company_info: tool({ description: "Get the company description.", inputSchema: z.object({}), execute: async () => { calls.push("company_info"); return "We build retro cameras."; } }),
      },
      stopWhen: stepCountIs(6),
      maxOutputTokens: 400,
    });
    if (res.steps.length < 2) throw new Error(`only ${res.steps.length} step(s); tools were not chained`);
    return `${res.steps.length} steps, tools: ${calls.join(",")}`;
  });
}
await step("embeddings", async () => { const [v] = await embed(["hello probe"]); return `${v!.length} dims`; });
process.exit(failed ? 1 : 0);
