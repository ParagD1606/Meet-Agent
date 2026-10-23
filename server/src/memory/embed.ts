import { config } from "../config";
import { log } from "../log";

export type Embedder = (texts: string[]) => Promise<number[][]>;

const BATCH = 96;
const MAX_CHARS = 8000; // keeps inputs under the 8191-token limit of OpenAI-style embedding models
const RETRIES = 3;

let override: Embedder | null = null;
/** Test seam: replace the network embedder. Pass null to restore. */
export function setEmbedder(fn: Embedder | null): void {
  override = fn;
}

function endpoint(): { url: string; key: string } {
  const key = config.EMBEDDING_API_KEY ?? config.MODEL_API_KEY;
  if (!key && !config.MODEL_BASE_URL) {
    throw new Error("Embeddings are not configured: set EMBEDDING_API_KEY (or MODEL_API_KEY / MODEL_BASE_URL)");
  }
  const base = (config.MODEL_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return { url: `${base}/embeddings`, key: key ?? "none" };
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const { url, key } = endpoint();
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: config.EMBEDDING_MODEL, input: texts }),
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

/** Embeds texts (batched). Every vector is validated against EMBEDDING_DIM. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const clipped = texts.map((t) => (t.trim() ? t.slice(0, MAX_CHARS) : " "));
  const out: number[][] = [];
  const run = override ?? embedBatch;
  for (let i = 0; i < clipped.length; i += BATCH) out.push(...(await run(clipped.slice(i, i + BATCH))));
  if (out.length !== texts.length) throw new Error(`embedder returned ${out.length} vectors for ${texts.length} texts`);
  for (const v of out) {
    if (v.length !== config.EMBEDDING_DIM) {
      throw new Error(`embedding has ${v.length} dims but EMBEDDING_DIM=${config.EMBEDDING_DIM}`);
    }
  }
  return out;
}
