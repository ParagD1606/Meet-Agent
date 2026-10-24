// QA LOW: context-prefix batches never mix scopes in one LLM prompt.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { backfillContextPrefixes } from "../../src/memory/context-prefix";
import { setMemoryLlm } from "../../src/memory/llm";
import { resetDb } from "../db";
import { installFakes, removeFakes, seedMemory } from "../memory/helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(resetDb);

test("a shared fact and a private fact are never in the same prompt", async () => {
  const prompts: string[] = [];
  setMemoryLlm(async (a) => { prompts.push(a.prompt); return '{"contexts":[]}'; });
  await seedMemory("shared", "Office opens at nine");
  await seedMemory("channel_GP", "Layoffs planned for March");
  await seedMemory("user_U1", "Ann's salary is high");
  await backfillContextPrefixes();
  expect(prompts.length).toBe(3);
  for (const p of prompts) expect([/Office/, /Layoffs/, /salary/].filter((r) => r.test(p))).toHaveLength(1);
});
