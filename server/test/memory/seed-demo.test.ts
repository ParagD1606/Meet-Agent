import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { db, resetDb } from "../db";
import { commitments, memories } from "../../src/db/schema";
import { seedDemo, seedGuard } from "../../scripts/seed-demo";
import { installFakes, removeFakes } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(resetDb);

test("guard: needs --yes; refuses production without --force", () => {
  expect(seedGuard(new Set(), "development")).toContain("--yes");
  expect(seedGuard(new Set(["--yes"]), "production")).toContain("--force");
  expect(seedGuard(new Set(["--yes", "--force"]), "production")).toBeNull();
  expect(seedGuard(new Set(["--yes"]), "development")).toBeNull();
});

test("seeding twice is idempotent and includes a superseded fact, decisions and commitments", async () => {
  const a = await seedDemo();
  expect(a.added).toBeGreaterThanOrEqual(40);
  const count = async () => (await db.select().from(memories)).length;
  const n = await count();
  const b = await seedDemo();
  expect(b.added).toBe(0);
  expect(await count()).toBe(n);
  const rows = await db.select().from(memories);
  expect(rows.filter((r) => r.status === "superseded")).toHaveLength(1);
  expect(rows.filter((r) => r.factType === "decision").length).toBeGreaterThanOrEqual(3);
  expect(rows.some((r) => r.scopeTag === "channel_CDEMO_FIN")).toBe(true);
  expect(await db.select().from(commitments)).toHaveLength(2);
});
