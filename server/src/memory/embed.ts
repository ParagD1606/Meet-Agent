import { inArray } from "drizzle-orm";
import { config } from "../config";
import { sha256 } from "../crypto";
import { db } from "../db";
import { embeddingCache } from "../db/schema";
import { log } from "../log";

export type Embedder = (texts: string[]) => Promise<number[][]>;

const BATCH = 96;
const MAX_CHARS = 8000; // keeps inputs under the 8191-token limit of OpenAI-style embedding models
const RETRIES = 3;
/** Models whose API accepts `dimensions` (Matryoshka); others return their native size and must match EMBEDDING_DIM. */
const SUPPORTS_DIMENSIONS = /^(text-embedding-3|gemini-embedding)/;

let override: Embedder | null = null;
let overrideCached = false;
/** Test seam: replace the network embedder. Pass null to restore. The content-hash cache is bypassed for overrides unless `useCache`. */
export function setEmbedder(fn: Embedder | null, opts?: { useCache?: boolean }): void {
  override = fn;
  overrideCached = !!opts?.useCache;
}

/** Cache counters, for tests and the usage page. */
export const embedStats = { hits: 0, misses: 0, calls: 0 };

function endpoint(): { url: string; key: string } {
  const explicit = config.EMBEDDING_BASE_URL;
  if (explicit) {
    // A dedicated embedding host never receives the chat key.
    return { url: `${explicit.replace(/\/+$/, "")}/embeddings`, key: config.EMBEDDING_API_KEY ?? "none" };
  }
  const key = config.EMBEDDING_API_KEY ?? config.MODEL_API_KEY;
  if (!key && !config.MODEL_BASE_URL) {
    throw new Error("Embeddings are not configured: set EMBEDDING_API_KEY (and EMBEDDING_BASE_URL for non-OpenAI hosts)");
  }
  const base = (config.MODEL_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return { url: `${base}/embeddings`, key: key ?? "none" };
}

let vertexAuth: { getAccessToken(): Promise<string | null | undefined> } | null = null;

/** Gemini embeddings on Vertex (predict API), authenticated with Application Default Credentials. */
async function embedBatchVertex(texts: string[]): Promise<number[][]> {
  const project = config.GOOGLE_VERTEX_PROJECT;
  if (!project) throw new Error("GOOGLE_VERTEX_PROJECT is required for Vertex embeddings");
  const { GoogleAuth } = await import("google-auth-library");
  const auth = (vertexAuth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }));
  const loc = config.GOOGLE_VERTEX_EMBED_LOCATION;
  const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${project}/locations/${loc}/publishers/google/models/${config.GOOGLE_VERTEX_EMBED_MODEL}:predict`;
  const out: number[][] = [];
  // gemini-embedding-001 accepts one input per request.
  for (const content of texts) {
    let lastErr: unknown;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        const token = await auth.getAccessToken();
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-goog-user-project": project },
          body: JSON.stringify({ instances: [{ content }], parameters: { outputDimensionality: config.EMBEDDING_DIM } }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`vertex embeddings HTTP ${res.status}`);
        if (!res.ok) throw Object.assign(new Error(`vertex embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`), { fatal: true });
        const json = (await res.json()) as { predictions?: { embeddings?: { values: number[] } }[] };
        const v = json.predictions?.[0]?.embeddings?.values;
        if (!v) throw new Error("vertex embeddings response malformed");
        out.push(v);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if ((e as { fatal?: boolean }).fatal) break;
        if (attempt < RETRIES - 1) await Bun.sleep(300 * 2 ** attempt);
      }
    }
    if (lastErr) {
      log.error("embed failed", { err: String(lastErr) });
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }
  }
  return out;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (config.MODEL_PROVIDER === "vertex" && !config.EMBEDDING_BASE_URL) return embedBatchVertex(texts); // ADC JSON only: a leftover EMBEDDING_API_KEY is ignored
  const { url, key } = endpoint();
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: config.EMBEDDING_MODEL, input: texts, ...(SUPPORTS_DIMENSIONS.test(config.EMBEDDING_MODEL) ? { dimensions: config.EMBEDDING_DIM } : {}) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`embeddings HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`), { fatal: true });
      const json = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
      if (!json.data || json.data.length !== texts.length) throw new Error("embeddings response malformed");
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch (e) {
      lastErr = e;
      if ((e as { fatal?: boolean }).fatal) break;
      if (attempt < RETRIES - 1) await Bun.sleep(300 * 2 ** attempt);
    }
  }
  log.error("embed failed", { err: String(lastErr) });
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const cacheKey = (text: string) => {
  const model = config.MODEL_PROVIDER === "vertex" ? config.GOOGLE_VERTEX_EMBED_MODEL : config.EMBEDDING_MODEL;
  return sha256(`${model}:${config.EMBEDDING_DIM}\n${text}`);
};

async function readCache(hashes: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  try {
    const rows = await db.select().from(embeddingCache).where(inArray(embeddingCache.hash, hashes));
    for (const r of rows) out.set(r.hash, r.embedding);
  } catch (e) {
    log.warn("embedding cache read failed", { err: e instanceof Error ? e.name : "unknown" });
  }
  return out;
}

async function writeCache(entries: { hash: string; embedding: number[] }[]): Promise<void> {
  if (!entries.length) return;
  try {
    await db.insert(embeddingCache).values(entries).onConflictDoNothing();
  } catch (e) {
    log.warn("embedding cache write failed", { err: e instanceof Error ? e.name : "unknown" });
  }
}

async function network(texts: string[]): Promise<number[][]> {
  const run = override ?? embedBatch;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    embedStats.calls++;
    out.push(...(await run(texts.slice(i, i + BATCH))));
  }
  return out;
}

/**
 * Embeds texts. Identical content (same model+dim) is served from `embedding_cache` and duplicates within the
 * call are embedded once; misses go out batched. Every vector is validated against EMBEDDING_DIM.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const clipped = texts.map((t) => (t.trim() ? t.slice(0, MAX_CHARS) : " "));
  const useCache = override ? overrideCached : true;

  let out: number[][];
  if (!useCache) {
    out = await network(clipped);
  } else {
    const hashes = clipped.map(cacheKey);
    const cached = await readCache([...new Set(hashes)]);
    const missIdx = new Map<string, number>(); // hash -> index into `missing`
    const missing: string[] = [];
    clipped.forEach((t, i) => {
      const h = hashes[i]!;
      if (!cached.has(h) && !missIdx.has(h)) { missIdx.set(h, missing.length); missing.push(t); }
    });
    embedStats.hits += clipped.length - missing.length;
    embedStats.misses += missing.length;
    const fresh = missing.length ? await network(missing) : [];
    if (fresh.length !== missing.length) throw new Error(`embedder returned ${fresh.length} vectors for ${missing.length} texts`);
    for (const v of fresh) {
      if (v.length !== config.EMBEDDING_DIM) throw new Error(`embedding has ${v.length} dims but EMBEDDING_DIM=${config.EMBEDDING_DIM}`);
    }
    await writeCache([...missIdx.entries()].map(([hash, i]) => ({ hash, embedding: fresh[i]! })));
    out = clipped.map((_, i) => cached.get(hashes[i]!) ?? fresh[missIdx.get(hashes[i]!)!]!);
  }
  if (out.length !== texts.length) throw new Error(`embedder returned ${out.length} vectors for ${texts.length} texts`);
  for (const v of out) {
    if (v.length !== config.EMBEDDING_DIM) {
      throw new Error(`embedding has ${v.length} dims but EMBEDDING_DIM=${config.EMBEDDING_DIM}`);
    }
  }
  return out;
}
