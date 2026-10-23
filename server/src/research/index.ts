import type { WebClient } from "@slack/web-api";
import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { and, count, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { id as newId } from "../crypto";
import { db } from "../db";
import { channels, researchRuns } from "../db/schema";
import { getModel } from "../llm";
import { log } from "../log";
import type { ToolContext } from "../turn/tools";

export const MAX_SUBQUESTIONS = 5;
export const MAX_ACTIVE_PER_USER = 3;
const WRITE_TOOLS = new Set(["memory_remember", "request_connection", "schedule_automation", "cancel_automation", "start_research"]);

export type Finding = { question: string; answer: string };
export type ResearchLlm = {
  plan(question: string): Promise<string[]>;
  investigate(sub: string, parent: string, tools: ToolSet): Promise<string>;
  synthesize(question: string, findings: Finding[]): Promise<string>;
};
export type ResearchDeps = {
  llm: ResearchLlm;
  tools(ctx: ToolContext): Promise<ToolSet>;
  post(channelId: string, threadTs: string | undefined, text: string): Promise<void>;
};

// ---------- default implementations ----------
const defaultLlm: ResearchLlm = {
  async plan(question) {
    const { text } = await generateText({
      model: getModel("fast"),
      system: `Split the research question into at most ${MAX_SUBQUESTIONS} focused, non-overlapping sub-questions that together answer it. Output one sub-question per line, no numbering, no commentary. If the question is already focused, output it unchanged.`,
      prompt: question,
    });
    return parsePlan(text);
  },
  async investigate(sub, parent, tools) {
    const { text } = await generateText({
      model: getModel("thorough"),
      tools,
      stopWhen: stepCountIs(10),
      system:
        "You are a research analyst. Answer the sub-question using team memory first, then the web and connected read-only tools. Be specific, cite sources (URL or memory) inline, and say plainly what you could not find. Never invent facts. Max ~200 words.",
      prompt: `Overall question: ${parent}\n\nSub-question: ${sub}`,
    });
    return text;
  },
  async synthesize(question, findings) {
    const { text } = await generateText({
      model: getModel("thorough"),
      system:
        "Write the final research brief for Slack (mrkdwn): the direct answer first, then key evidence, then open questions or confidence caveats. Stay under 3000 characters. Only use the findings given; flag conflicts and gaps honestly.",
      prompt: `Question: ${question}\n\n${findings.map((f, i) => `Finding ${i + 1} — ${f.question}\n${f.answer}`).join("\n\n")}`,
    });
    return text;
  },
};

export const deps: ResearchDeps = {
  llm: defaultLlm,
  tools: async (ctx) => {
    const all = await (await import("../turn/tools")).buildTools(ctx);
    return Object.fromEntries(Object.entries(all).filter(([name]) => !WRITE_TOOLS.has(name))) as ToolSet;
  },
  post: async (channel, thread_ts, text) => {
    const slack: WebClient = await (await import("../slack/client")).slackClient();
    const r = await slack.chat.postMessage({ channel, thread_ts, text: text.slice(0, 3900), unfurl_links: false });
    if (!r.ok) throw new Error(r.error ?? "post failed");
  },
};

export function parsePlan(text: string): string[] {
  return [...new Set(text.split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter((l) => l.length > 3))].slice(0, MAX_SUBQUESTIONS);
}

// ---------- public API ----------
export async function startResearch(a: { requesterId: string; channelId: string; threadTs?: string; question: string }): Promise<string> {
  const question = a.question.trim();
  if (!question) throw new Error("question required");
  const [{ n }] = await db
    .select({ n: count() })
    .from(researchRuns)
    .where(and(eq(researchRuns.requesterId, a.requesterId), inArray(researchRuns.status, ["planned", "running"])));
  if (n >= MAX_ACTIVE_PER_USER) throw new Error(`too many research runs in progress (max ${MAX_ACTIVE_PER_USER}); wait for one to finish`);
  const id = newId("rs_");
  await db.insert(researchRuns).values({ id, requesterId: a.requesterId, channelId: a.channelId, threadTs: a.threadTs ?? null, question });
  try {
    await (await import("../jobs")).enqueueResearch(id);
  } catch (err) {
    await db.update(researchRuns).set({ status: "failed", result: `could not enqueue: ${String(err)}` }).where(eq(researchRuns.id, id));
    throw err;
  }
  return id;
}

/** Runs one planned research run end to end. Idempotent: only a `planned` row is claimed. */
export async function runResearch(id: string, override: Partial<ResearchDeps> = {}): Promise<"done" | "failed" | "skipped"> {
  const d = { ...deps, ...override };
  const [run] = await db
    .update(researchRuns)
    .set({ status: "running" })
    .where(and(eq(researchRuns.id, id), eq(researchRuns.status, "planned")))
    .returning();
  if (!run) return "skipped";
  const thread = run.threadTs ?? undefined;

  try {
    const [ch] = await db.select().from(channels).where(eq(channels.id, run.channelId));
    // Unknown channel => treat as private so memory scoping is as narrow as possible.
    const scope = { channelId: run.channelId, isPrivate: ch ? ch.isPrivate : true, isIm: ch?.isIm ?? false, userId: run.requesterId };
    const tools = await d.tools({
      turnId: run.id,
      userId: run.requesterId,
      channelId: run.channelId,
      threadTs: thread,
      scope,
      readOnly: true,
      orgConnectionsOnly: true,
    });

    const subs = (await d.llm.plan(run.question)).slice(0, MAX_SUBQUESTIONS);
    const questions = subs.length ? subs : [run.question];
    await db.update(researchRuns).set({ plan: { subQuestions: questions } }).where(eq(researchRuns.id, id));

    const settled = await Promise.allSettled(questions.map((q) => d.llm.investigate(q, run.question, tools)));
    const findings: Finding[] = settled.flatMap((s, i) =>
      s.status === "fulfilled" && s.value.trim() ? [{ question: questions[i]!, answer: s.value.trim() }] : [],
    );
    if (!findings.length) throw new Error("no sub-question produced a finding");

    const result = (await d.llm.synthesize(run.question, findings)).trim();
    if (!result) throw new Error("empty synthesis");
    await d.post(run.channelId, thread, result);
    await db.update(researchRuns).set({ status: "done", result }).where(eq(researchRuns.id, id));
    return "done";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("research failed", { id, err: msg });
    await db.update(researchRuns).set({ status: "failed", result: msg.slice(0, 500) }).where(eq(researchRuns.id, id));
    await d.post(run.channelId, thread, `I couldn't finish that research (${msg.slice(0, 200)}).`).catch(() => undefined);
    return "failed";
  }
}

/** Boot-time cleanup: a worker killed mid-run leaves `running` forever (jobs don't retry research). */
export async function failStaleResearch(olderThanMs = 60 * 60_000): Promise<number> {
  const rows = await db
    .update(researchRuns)
    .set({ status: "failed", result: "interrupted by restart" })
    .where(and(eq(researchRuns.status, "running"), lt(researchRuns.createdAt, new Date(Date.now() - olderThanMs))))
    .returning({ id: researchRuns.id });
  return rows.length;
}

export function researchTools(ctx: ToolContext): ToolSet {
  return {
    start_research: tool({
      description:
        "Kick off a deeper background research run (plans sub-questions, searches memory, the web and read-only tools in parallel, then posts a synthesized brief in this thread). Use for questions that need more than a quick lookup. Returns immediately.",
      inputSchema: z.object({ question: z.string().describe("The full research question, self-contained.") }),
      execute: async ({ question }) => {
        if (!ctx.userId) return "Can't start research: the asker's identity is unknown.";
        try {
          await startResearch({ requesterId: ctx.userId, channelId: ctx.channelId, threadTs: ctx.threadTs, question });
          return "Research started. I'll post the result in this thread when it's done.";
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}
