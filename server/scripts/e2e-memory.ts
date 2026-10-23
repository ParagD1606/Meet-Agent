// Real (unmocked) memory pipeline check against Ollama + Postgres:
//   DATABASE_URL=... EMBEDDING_DIM=768 MODEL_BASE_URL=http://localhost:11434/v1 MODEL_NAME=llama3.2:3b \
//   EMBEDDING_MODEL=nomic-embed-text bun scripts/e2e-memory.ts
import { runMigrations } from "../src/db/migrate";
import { captureTurn } from "../src/memory/writeback";
import { searchMemory } from "../src/memory/search";
import { addFact } from "../src/memory/supersede";
import { readTags } from "../src/memory/scope";
import { pool } from "../src/db";

await runMigrations();
const pub = { channelId: "C_PUB", isPrivate: false, isIm: false, userId: "U1" };

const n = await captureTurn({ scope: pub, transcript: "Alice: we decided pricing stays at $400/mo usage based.\nBob: agreed, Mahesh owns the pricing page launch on Friday." });
console.log("facts stored from public turn:", n);
await addFact({ tag: "channel_C_PRIV", text: "Project Falcon codename is the secret acquisition of Acme.", source: "slack" });

const hits = await searchMemory({ tags: await readTags(pub), query: "what is our pricing?" });
console.log("public search:", hits.slice(0, 3).map((h) => `${h.scopeTag}: ${h.text}`));
const leak = await searchMemory({ tags: await readTags(pub), query: "Project Falcon acquisition" });
console.log("public sees private?", leak.some((h) => h.scopeTag === "channel_C_PRIV"));

const old = await addFact({ tag: "shared", text: "Pricing is $400/mo.", source: "slack" });
const upd = await addFact({ tag: "shared", text: "Pricing changed to $500/mo, replacing the old $400/mo price.", source: "slack" });
console.log("supersede:", { oldId: old.id, newId: upd.id, superseded: upd.superseded });
const after = await searchMemory({ tags: ["shared"], query: "current price per month" });
console.log("after supersede top:", after[0]?.text, "| old still returned:", after.some((h) => h.id === old.id));
await pool.end();
