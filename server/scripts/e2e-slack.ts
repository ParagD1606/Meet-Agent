// Full-loop check with a fake Slack API and REAL model/embeddings/Postgres:
//   DATABASE_URL=... ENCRYPTION_KEY=... SLACK_MODE=http SLACK_SIGNING_SECRET=s SLACK_API_URL=http://localhost:4555/api/ \
//   EMBEDDING_DIM=768 MODEL_BASE_URL=http://localhost:11434/v1 MODEL_NAME=llama3.2:3b MODEL_API_KEY=ollama \
//   EMBEDDING_API_KEY=ollama EMBEDDING_MODEL=nomic-embed-text bun scripts/e2e-slack.ts
import { createHmac } from "node:crypto";
import { app } from "../src/app";
import { runMigrations } from "../src/db/migrate";
import { db, pool } from "../src/db";
import { channels, channelMembers, users, workspace } from "../src/db/schema";
import { encrypt } from "../src/crypto";
import { addFact } from "../src/memory/supersede";

const calls: { method: string; body: Record<string, any> }[] = [];
const fake = Bun.serve({
  port: 4555,
  async fetch(req) {
    const method = new URL(req.url).pathname.split("/").pop()!;
    const text = await req.text();
    const body = Object.fromEntries(new URLSearchParams(text));
    calls.push({ method, body });
    return Response.json({
      ok: true, ts: String(Date.now() / 1000), channel: body.channel ?? "C1", messages: [], members: ["UASK"], response_metadata: {},
      user: { id: "UASK", name: "asker", real_name: "Asker", profile: { display_name: "asker" } },
      channel_info: {}, user_id: "UBOT", team_id: "T1",
    });
  },
});

await runMigrations();
await db.insert(workspace).values({ id: "T1", name: "Test", botTokenEnc: encrypt("xoxb-fake"), botUserId: "UBOT" }).onConflictDoNothing();
await db.insert(users).values([{ id: "UASK", name: "Asker" }]).onConflictDoNothing();
await db.insert(channels).values({ id: "C1", name: "general", botIsMember: true }).onConflictDoNothing();
await db.insert(channelMembers).values({ channelId: "C1", userId: "UASK" }).onConflictDoNothing();
await addFact({ tag: "shared", text: "Our pricing is $400 per month, usage based, decided by Alice and Mahesh.", source: "e2e" });

const sign = (body: string) => {
  const ts = String(Math.floor(Date.now() / 1000));
  return { "x-slack-request-timestamp": ts, "x-slack-signature": "v0=" + createHmac("sha256", process.env.SLACK_SIGNING_SECRET!).update(`v0:${ts}:${body}`).digest("hex"), "content-type": "application/json" };
};
const send = async (text: string) => {
  const ts = (Date.now() / 1000).toFixed(6);
  const body = JSON.stringify({ type: "event_callback", event_id: "Ev" + ts, team_id: "T1", event: { type: "app_mention", user: "UASK", channel: "C1", text: `<@UBOT> ${text}`, ts } });
  const res = await app.request("/slack/events", { method: "POST", headers: sign(body), body });
  console.log("POST /slack/events ->", res.status);
};

await send("what is our pricing?");
const deadline = Date.now() + 120_000;
const finalReply = () => calls.filter((c) => (c.method === "chat.postMessage" || c.method === "chat.update") && /400/.test(c.body.text ?? JSON.stringify(c.body.blocks ?? "")));
while (Date.now() < deadline && finalReply().length === 0) await Bun.sleep(1000);

console.log("slack methods called:", [...new Set(calls.map((c) => c.method))].join(", "));
const out = finalReply().at(-1);
console.log(out ? "REPLY: " + (out.body.text ?? "").slice(0, 300) : "NO REPLY mentioning $400 within 120s");
const { rows } = await pool.query("select status, trigger, input_tokens, output_tokens, error from turns order by started_at desc limit 1");
console.log("turn row:", rows[0]);
fake.stop(true);
await pool.end();
process.exit(out ? 0 : 1);
