import "./env";

import { sql } from "drizzle-orm";
import { encrypt } from "../../src/crypto";
import { db } from "../db";
import { resetDb } from "../db";
import { channels, workspace } from "../../src/db/schema";
import { setSlackClientForTest } from "../../src/slack/client";
import { deps } from "../../src/slack/deps";

export const BOT = "UBOT";
export const TEAM = "T1";

/** Recording fake of the @slack/web-api client: any `a.b.c(args)` is logged; `responses["a.b.c"]` customises the reply. */
export function fakeSlack(responses: Record<string, (args: any) => any> = {}) {
  const calls: { method: string; args: any }[] = [];
  const mk = (path: string[]): any =>
    new Proxy(function () {}, {
      get: (_t, k: string) => (k === "then" ? undefined : mk([...path, k])),
      apply: async (_t, _this, [args]) => {
        const m = path.join(".");
        calls.push({ method: m, args });
        const r = responses[m];
        if (r) return r(args);
        if (m === "conversations.open") return { ok: true, channel: { id: "D_" + args.users } };
        if (m === "chat.postMessage") return { ok: true, ts: "999.1" };
        if (m === "users.info") return { ok: true, user: { id: args.user, real_name: "User " + args.user, profile: { email: args.user + "@x.io" } } };
        return { ok: true };
      },
    });
  return { client: mk([]), calls, count: (m: string) => calls.filter((c) => c.method === m).length };
}

export async function setup(responses: Record<string, (args: any) => any> = {}) {
  await resetDb();
  await db.execute(sql`create table if not exists message_feedback (
    id bigserial primary key, channel_id text not null, message_ts text not null, user_id text not null,
    rating text not null, created_at timestamptz not null default now())`);
  await db.execute(sql`create unique index if not exists message_feedback_uniq on message_feedback (channel_id, message_ts, user_id)`);
  await db.insert(workspace).values({ id: TEAM, name: "Acme", botTokenEnc: encrypt("xoxb-test"), botUserId: BOT, homeChannelId: "CHOME" });
  const fake = fakeSlack(responses);
  setSlackClientForTest(fake.client);
  const turns: any[] = [];
  deps.runTurn = async (i) => { turns.push(i); };
  const blockActions: any[] = [];
  deps.handleBlockAction = async (p) => { blockActions.push(p); return true; };
  return { fake, turns, blockActions };
}

export const addChannel = (id: string, o: Partial<typeof channels.$inferInsert> = {}) =>
  db.insert(channels).values({ id, name: id.toLowerCase(), botIsMember: true, ...o });

let n = 0;
export const evt = (event: Record<string, any>, extra: Record<string, any> = {}) =>
  ({ event_id: `Ev${++n}`, team_id: TEAM, type: "event_callback", event, ...extra });
let tsn = 1700000000;
export const nextTs = () => `${++tsn}.000100`;
