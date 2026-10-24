import { describe, expect, test } from "bun:test";
import { channelMembers, channels, coreBlocks } from "../../src/db/schema";
import { call, db, login, resetDb } from "./helpers";

describe("GET /api/channels", () => {
  test("members only see their own channels; admins see all non-DM channels; DMs never", async () => {
    await resetDb();
    await db.insert(channels).values([
      { id: "C1", name: "eng", botIsMember: true }, { id: "C2", name: "secret", isPrivate: true }, { id: "C3", name: "random" }, { id: "D1", name: null, isIm: true },
    ]);
    await db.insert(channelMembers).values([{ channelId: "C1", userId: "UM" }, { channelId: "D1", userId: "UM" }, { channelId: "C2", userId: "UX" }]);
    await db.insert(coreBlocks).values({ id: "cb1", scopeTag: "channel_C1", label: "channel", text: "Project: x", charLimit: 1000 });
    const member = await login("UM", "member");
    const admin = await login("UA", "admin");
    const m = await (await call("GET", "/api/channels", { cookie: member })).json() as any[];
    expect(m.map((x) => x.id)).toEqual(["C1"]);
    expect(m[0]).toMatchObject({ name: "eng", isPrivate: false, isIm: false, botIsMember: true, hasCoreBlock: true });
    const a = await (await call("GET", "/api/channels", { cookie: admin })).json() as any[];
    expect(a.map((x) => x.id).sort()).toEqual(["C1", "C2", "C3"]);
    expect(a.find((x) => x.id === "C2").hasCoreBlock).toBe(false);
    expect((await call("GET", "/api/channels")).status).toBe(401);
  });
});
