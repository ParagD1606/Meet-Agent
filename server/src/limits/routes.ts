import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../auth/session";
import { readBody, readQuery } from "../routes/util";
import { costReport } from "../cost";
import { usageReport } from "./report";
import { getLimits, limitsSchema, setLimits } from "./settings";

export const limitsRoutes = new Hono<AppEnv>();

limitsRoutes.get("/usage", requireAuth("admin"), async (c) => {
  const { range } = readQuery(c, z.object({ range: z.enum(["1d", "7d", "30d", "90d"]).default("7d") }));
  return c.json(await usageReport(range));
});

limitsRoutes.get("/usage/cost", requireAuth("admin"), async (c) => {
  const { days } = readQuery(c, z.object({ days: z.coerce.number().int().min(1).max(400).default(30) }));
  return c.json(await costReport(days));
});

limitsRoutes.get("/settings/limits", requireAuth("admin"), async (c) => c.json(await getLimits()));
limitsRoutes.put("/settings/limits", requireAuth("admin"), async (c) => c.json(await setLimits(await readBody(c, limitsSchema))));
