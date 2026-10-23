import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../auth/session";
import { db } from "../db";
import { memories } from "../db/schema";
import { log } from "../log";
import { deleteMemory, getGraph, listMemories } from "../memory/graph";
import { ingestDocument } from "../memory/ingest";
import { httpError, readQuery } from "./util";

export const memory = new Hono<AppEnv>();

// The web UI only ever sees the org-wide "shared" tag, whatever the viewer's role: private channel
// and DM memories are reachable through Slack scopes only.
const TAGS = ["shared"];
const MAX_UPLOAD = 20 * 1024 * 1024;

memory.get("/graph", requireAuth(), async (c) => {
  const { limit } = readQuery(c, z.object({ limit: z.coerce.number().int().min(1).max(2000).default(300) }));
  return c.json(await getGraph({ tags: TAGS, limit }));
});

memory.get("/memories", requireAuth(), async (c) => {
  const q = readQuery(c, z.object({
    q: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }));
  return c.json(await listMemories({ tags: TAGS, ...q }));
});

memory.delete("/memories/:id", requireAuth("admin"), async (c) => {
  const memId = Number(c.req.param("id"));
  if (!Number.isInteger(memId)) throw httpError(400, "invalid_id");
  const [row] = await db.select({ tag: memories.scopeTag }).from(memories).where(eq(memories.id, memId));
  // Hide non-shared memories entirely: admins can't see or delete someone's private memory from here.
  if (!row || row.tag !== "shared") throw httpError(404, "not_found");
  await deleteMemory(memId);
  return c.json({ ok: true });
});

memory.post("/memories/upload", requireAuth("admin"), async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!(file instanceof File)) throw httpError(400, "invalid_body", { issues: [{ path: "file", message: "multipart field 'file' required" }] });
  if (file.size > MAX_UPLOAD) throw httpError(413, "file_too_large");
  try {
    const chunks = await ingestDocument({
      tag: "shared", name: file.name, mimeType: file.type || "application/octet-stream",
      data: Buffer.from(await file.arrayBuffer()), source: "upload", sourceRef: file.name,
    });
    return c.json({ name: file.name, chunks }, 201);
  } catch (e) {
    log.warn("upload ingest failed", { name: file.name, err: String(e) });
    throw httpError(400, "ingest_failed", { message: e instanceof Error ? e.message : String(e) });
  }
});
