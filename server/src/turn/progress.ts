import { tool, type ToolSet } from "ai";
import { z } from "zod";

export const MAX_UPDATES_PER_TURN = 4;

/**
 * post_update is the only way text reaches the thread before the final answer: the model's text between tool
 * calls is never shown. `narrate` posts one standalone message and returns whether it was delivered.
 * Duplicates and anything past the per-turn cap are dropped so a chatty model cannot spam a thread.
 */
export function createProgressTools(narrate?: (text: string) => Promise<boolean>): ToolSet {
  if (!narrate) return {};
  const sent: string[] = [];
  return {
    post_update: tool({
      description: "Post one short standalone progress message to the thread. Only when real work will take a while, or a real finding lands. Never per step, never filler, never repeat.",
      inputSchema: z.object({ message: z.string().min(1).max(1500).describe("Plain Slack markdown carrying real content") }),
      execute: async ({ message }) => {
        const text = message.trim();
        if (!text) return { posted: false };
        const norm = text.toLowerCase().replace(/\s+/g, " ");
        if (sent.length >= MAX_UPDATES_PER_TURN || sent.includes(norm)) return { posted: false, reason: "skipped (duplicate or update limit)" };
        const posted = await narrate(text).catch(() => false);
        if (posted) sent.push(norm);
        return { posted };
      },
    }),
  };
}
