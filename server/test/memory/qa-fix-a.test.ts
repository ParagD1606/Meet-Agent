import "../turn/env";
import { beforeEach, describe, expect, test } from "bun:test";
import { memories } from "../../src/db/schema";
import { addFact } from "../../src/memory/supersede";
import { setMemoryLlm } from "../../src/memory/llm";
import { deleteMemory } from "../../src/memory/graph";
import { call, db, login, resetDb } from "../api/helpers";
import { fakeVector, installFakes } from "./helpers";

describe("held facts visibility", () => {
  beforeEach(async () => { await resetDb(); installFakes(); });
  test("admin still sees pending facts in GET /api/memories", async () => {
    const admin = await login("A1", "admin");
    await db.insert(memories).values([
      { scopeTag: "shared", text: "live", embedding: fakeVector("a") },
      { scopeTag: "shared", text: "held", embedding: fakeVector("b"), reviewState: "pending" },
    ]);
    const list = (await (await call("GET", "/api/memories", { cookie: admin })).json()) as { items: { text: string }[] };
    expect(list.items.map((i) => i.text).sort()).toEqual(["held", "live"]);
  });
  test("deleting a superseder does not restore a held original", async () => {
    const a = await addFact({ tag: "shared", text: "Billing owner is Priya for this quarter", source: "t" });
    setMemoryLlm(async () => `{"superseded":[${a.id}]}`);
    const b = await addFact({ tag: "shared", text: "Billing owner is Dana for this quarter", source: "t" });
    await db.update(memories).set({ reviewState: "pending" }).where((await import("drizzle-orm")).eq(memories.id, a.id));
    await deleteMemory(b.id);
    const row = (await db.select().from(memories)).find((m) => m.id === a.id)!;
    expect(row.status).toBe("superseded");
    expect(row.supersededBy).toBeNull();
    installFakes();
  });
});
