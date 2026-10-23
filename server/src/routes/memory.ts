import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { hasRole, requireAuth, type AppEnv } from "../auth/session";
import { db } from "../db";
import { memories } from "../db/schema";
import { log, redactError } from "../log";
import { deleteMemory, getGraph, listMemories, MAX_GRAPH_NODES } from "../memory/graph";
import { ingestDocument } from "../memory/ingest";
import { httpError, readQuery, sniffUpload } from "./util";

export const memory = new Hono<AppEnv>();

// The web UI only ever sees the org-wide "shared" tag, whatever the viewer's role: private channel
// and DM memories are reachable through Slack scopes only.
const TAGS = ["shared"];
const MAX_UPLOAD = 20 * 1024 * 1024;
const UPLOAD_SYNC_MS = 8_000;

memory.get("/graph", requireAuth(), async (c) => {
  const q = readQuery(c, z.object({
    limit: z.coerce.number().int().min(1).max(MAX_GRAPH_NODES).default(300),
    kind: z.enum(["fact", "chunk"]).optional(),
    source: z.string().max(40).optional(),
    q: z.string().max(200).optional(),
  }));
  return c.json(await getGraph({ tags: TAGS, ...q }));
});

memory.get("/memories", requireAuth(), async (c) => {
  const q = readQuery(c, z.object({
    q: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    status: z.enum(["active", "superseded", "all"]).default("active"),
  }));
  return c.json(await listMemories({ tags: TAGS, ...q, includeHeld: hasRole(c.get("user").role, "admin") }));
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
  const data = Buffer.from(await file.arrayBuffer());
  const mimeType = sniffUpload(data, file.type, file.name);
  if (!mimeType) throw httpError(415, "unsupported_file", { message: "Only text, Markdown, CSV, HTML and PDF files can be added." });
  // Embedding a big file can take a while: past UPLOAD_SYNC_MS the request is answered 202 and ingest finishes in the background.
  const work = ingestDocument({ tag: "shared", name: file.name, mimeType, data, source: "upload", sourceRef: file.name });
  const pending = Symbol("pending");
  try {
    const r = await Promise.race([work, new Promise<typeof pending>((res) => setTimeout(() => res(pending), UPLOAD_SYNC_MS))]);
    if (r === pending) {
      work.then((n) => log.info("upload ingested", { name: file.name, chunks: n }), (e) => log.warn("upload ingest failed", { name: file.name, err: redactError(e) }));
      return c.json({ name: file.name, status: "processing" }, 202);
    }
    return c.json({ name: file.name, chunks: r }, 201);
  } catch (e) {
    log.warn("upload ingest failed", { name: file.name, err: redactError(e) });
    throw httpError(400, "ingest_failed", { message: e instanceof Error ? e.message : String(e) });
  }
});
