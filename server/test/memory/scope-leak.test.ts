import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getGraph, listMemories } from "../../src/memory/graph";
import { type SlackScope, readTags, writeTag } from "../../src/memory/scope";
import { searchMemory } from "../../src/memory/search";
import { installFakes, removeFakes, seedChannel, seedMemory } from "./helpers";
import { resetDb } from "../db";

beforeAll(installFakes);
afterAll(removeFakes);

const pub: SlackScope = { channelId: "C_PUB", isPrivate: false, isIm: false, userId: "U1" };
const privC1: SlackScope = { channelId: "C_P1", isPrivate: true, isIm: false, userId: "U1" };
const privC2: SlackScope = { channelId: "C_P2", isPrivate: true, isIm: false, userId: "U2" };
const dmU1: SlackScope = { channelId: "D1", isPrivate: false, isIm: true, userId: "U1" };
const dmU2: SlackScope = { channelId: "D2", isPrivate: false, isIm: true, userId: "U2" };
const dmAnon: SlackScope = { channelId: "D3", isPrivate: false, isIm: true, userId: null };

describe("writeTag", () => {
  test("maps scopes to tags", () => {
    expect(writeTag(pub)).toBe("shared");
    expect(writeTag(privC1)).toBe("channel_C_P1");
    expect(writeTag(dmU1)).toBe("user_U1");
    expect(writeTag(dmAnon)).toBeNull();
    // IM wins even if flags are inconsistent
    expect(writeTag({ ...dmU1, isPrivate: true })).toBe("user_U1");
  });
});

describe("scope-leak matrix (real Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedChannel("C_PUB", {});
    await seedChannel("C_P1", { isPrivate: true, members: ["U1"] });
    await seedChannel("C_P2", { isPrivate: true, members: ["U2"] });
    await seedChannel("C_P3", { isPrivate: true, members: ["U3"] }); // nobody under test is in it
    await seedChannel("D1", { isIm: true, members: ["U1"] }); // IM rows must never grant read access
    for (const tag of ["shared", "channel_C_P1", "channel_C_P2", "channel_C_P3", "user_U1", "user_U2"]) {
      await seedMemory(tag, `launch plan secret for ${tag}`);
    }
    await seedMemory("shared", "launch plan superseded draft", { status: "superseded" });
  });

  const matrix: [string, SlackScope, string[]][] = [
    ["public channel", pub, ["shared"]],
    ["private channel 1", privC1, ["shared", "channel_C_P1"]],
    ["private channel 2", privC2, ["shared", "channel_C_P2"]],
    ["DM user 1 (member of C_P1)", dmU1, ["shared", "user_U1", "channel_C_P1"]],
    ["DM user 2 (member of C_P2)", dmU2, ["shared", "user_U2", "channel_C_P2"]],
    ["DM without a user", dmAnon, ["shared"]],
  ];

  for (const [name, scope, expected] of matrix) {
    test(`${name} reads exactly ${expected.join(",")}`, async () => {
      const tags = await readTags(scope);
      expect([...tags].sort()).toEqual([...expected].sort());

      const hits = await searchMemory({ tags, query: "launch plan secret" });
      expect(hits.map((h) => h.scopeTag).sort()).toEqual([...expected].sort());
      expect(hits.every((h) => h.text !== "launch plan superseded draft")).toBe(true);

      const listed = await listMemories({ tags, limit: 100, offset: 0 });
      expect(listed.items.map((m) => m.scopeTag).sort()).toEqual([...expected].sort());
      expect(listed.total).toBe(expected.length);

      const graph = await getGraph({ tags, limit: 100 });
      expect(graph.nodes.map((n) => n.scope).sort()).toEqual([...expected].sort());
    });
  }

  test("a private channel and a public channel never read a DM's rows, and DMs never read other DMs", async () => {
    const all = (await Promise.all([pub, privC1, privC2, dmU1, dmU2].map(async (s) => [s, await readTags(s)] as const)));
    for (const [s, tags] of all) {
      if (!s.isIm) expect(tags.some((t) => t.startsWith("user_"))).toBe(false);
    }
    expect((await readTags(dmU1)).includes("user_U2")).toBe(false);
    expect((await readTags(dmU2)).includes("user_U1")).toBe(false);
  });

  test("public/private scopes never widen with channel membership of the asker", async () => {
    // U1 is in C_P1, but a public-channel turn by U1 must still only see shared
    expect(await readTags(pub)).toEqual(["shared"]);
    expect(await readTags(privC2)).not.toContain("channel_C_P1");
  });

  test("search without tags is refused instead of searching everything", async () => {
    await expect(searchMemory({ tags: [], query: "launch" })).rejects.toThrow(/non-empty tags/);
  });

  test("empty tag lists yield empty list/graph results", async () => {
    expect(await listMemories({ tags: [], limit: 10, offset: 0 })).toEqual({ items: [], total: 0 });
    expect(await getGraph({ tags: [], limit: 10 })).toEqual({ nodes: [], edges: [], total: 0, truncated: false });
  });
});
