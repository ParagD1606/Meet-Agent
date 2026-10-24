// Shared by scenarios 13-15: the in-process fake MCP server (real MCP protocol, Notion-shaped tools) behind the real connection layer.
import { afterEach, beforeEach } from "bun:test";
import { invalidateApprovalCards } from "../../src/mcp/policy";
import { retryPolicy } from "../../src/mcp/reset-retry";
import { setFollowUp, type FollowUpInput } from "../../src/turn/followup";
import { startFakeMcp } from "../mcp/fake-server";

retryPolicy.backoffMs = 0;

export type Fake = Awaited<ReturnType<typeof startFakeMcp>>;
export const mcp: { fake: Fake; followUps: FollowUpInput[] } = { fake: undefined as never, followUps: [] };

/** Call inside a describe, AFTER the file's own boot() beforeEach, so the database is already reset. */
export function useFakeMcp() {
  beforeEach(async () => {
    invalidateApprovalCards();
    mcp.followUps = [];
    setFollowUp(async (i) => { mcp.followUps.push(i); });
    mcp.fake = await startFakeMcp();
  });
  afterEach(() => mcp.fake.stop());
}

export const creates = () => mcp.fake.calls.filter((c) => c.tool === "notion-create-pages");
/** Slack text the user can see: every post and update. */
export const said = (posts: { text: string }[]) => posts.map((p) => p.text).join("\n");
/** Denials the user must never get when the app IS connected (by someone). */
export const DENIAL = /only (have )?access to notion|don'?t have (access to )?github|do not have (access to )?github|no github (access|connection|integration)|github (isn'?t|is not) (connected|available)/i;
