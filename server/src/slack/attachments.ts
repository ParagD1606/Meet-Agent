import { extractText, getDocumentProxy } from "unpdf";
import { decrypt } from "../crypto";
import { log } from "../log";
import { getWorkspace } from "./client";

export type SlackFile = { id?: string; name?: string; title?: string; mimetype?: string; filetype?: string; size?: number; url_private_download?: string; url_private?: string };
export type TurnFile = { name: string; mimeType: string; text: string };

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_CHARS = 100_000;
const MAX_FILES = 5;
const TEXTY = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|x-ndjson))/;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|log|ts|tsx|js|jsx|py|go|rs|java|sql|sh)$/i;

export type Fetcher = (url: string, token: string) => Promise<{ ok: boolean; status: number; contentType: string; body: ArrayBuffer }>;
const defaultFetch: Fetcher = async (url, token) => {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  return { ok: r.ok, status: r.status, contentType: r.headers.get("content-type") ?? "", body: await r.arrayBuffer() };
};

const note = (name: string, mimeType: string, text: string): TurnFile => ({ name, mimeType, text });

/** Pure-ish: turn downloaded bytes into model-readable text (or an explanatory note). */
export async function extractFile(name: string, mime: string, bytes: ArrayBuffer): Promise<TurnFile> {
  const clip = (s: string) => (s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + "\n[truncated]" : s);
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return note(name, mime, clip(text) || "[PDF contained no extractable text (scanned?)]");
  }
  if (TEXTY.test(mime) || TEXT_EXT.test(name)) return note(name, mime, clip(new TextDecoder().decode(bytes)));
  if (mime.startsWith("image/")) return note(name, mime, "[image attached; image content is not read]");
  return note(name, mime, `[unsupported attachment type ${mime || "unknown"}; not read]`);
}

/** Download + extract files attached to a Slack message. Never throws; failures become notes. Token is never logged. */
export async function readSlackFiles(files: SlackFile[] | undefined, fetcher: Fetcher = defaultFetch): Promise<TurnFile[]> {
  if (!files?.length) return [];
  const ws = await getWorkspace();
  if (!ws) return [];
  const token = decrypt(ws.botTokenEnc);
  const out: TurnFile[] = [];
  for (const f of files.slice(0, MAX_FILES)) {
    const name = f.name ?? f.title ?? f.id ?? "file";
    const mime = f.mimetype ?? "";
    try {
      const url = f.url_private_download ?? f.url_private;
      if (!url) { out.push(note(name, mime, "[file has no downloadable URL]")); continue; }
      if (f.size && f.size > MAX_BYTES) { out.push(note(name, mime, `[file too large (${Math.round(f.size / 1e6)}MB); skipped]`)); continue; }
      if (mime.startsWith("image/")) { out.push(await extractFile(name, mime, new ArrayBuffer(0))); continue; }
      const res = await fetcher(url, token);
      if (!res.ok) { out.push(note(name, mime, `[download failed: HTTP ${res.status}]`)); continue; }
      if (res.contentType.startsWith("text/html") && !mime.startsWith("text/html")) {
        out.push(note(name, mime, "[download returned a login page; the app needs the files:read scope]")); continue;
      }
      if (res.body.byteLength > MAX_BYTES) { out.push(note(name, mime, "[file too large; skipped]")); continue; }
      out.push(await extractFile(name, mime, res.body));
    } catch (err) {
      log.warn("slack file read failed", { name, error: (err as Error).message });
      out.push(note(name, mime, "[could not read this file]"));
    }
  }
  if (files.length > MAX_FILES) out.push(note("(more files)", "", `[${files.length - MAX_FILES} additional files skipped]`));
  return out;
}
