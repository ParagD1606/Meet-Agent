import { config } from "../../config";
import { json, redirectUri, type DocRef, type SyncProvider } from "../types";

const API = "https://api.notion.com/v1";
const H = { "notion-version": "2022-06-28", "content-type": "application/json" };
const MAX_BLOCKS = 2000;
const MAX_DEPTH = 3;

type Rich = { plain_text: string }[];
type Block = { id: string; type: string; has_children?: boolean; [k: string]: any };
type Page = { id: string; last_edited_time: string; archived?: boolean; properties?: Record<string, { type: string; title?: Rich }> };

const titleOf = (p: Page) => {
  const t = Object.values(p.properties ?? {}).find((x) => x.type === "title");
  return t?.title?.map((r) => r.plain_text).join("") || "Untitled";
};

/**
 * Cursor: ISO watermark (newest last_edited_time already ingested), or while a search is paged,
 * JSON `{w,n,p}` = watermark, newest seen so far, Notion's next_cursor. Search is newest-first so
 * paging stops as soon as a page at or before the watermark appears.
 */
export const notion: SyncProvider = {
  id: "notion",
  configured: () => Boolean(config.NOTION_CLIENT_ID && config.NOTION_CLIENT_SECRET),
  authUrl(state) {
    const u = new URL(`${API}/oauth/authorize`);
    u.search = new URLSearchParams({
      client_id: config.NOTION_CLIENT_ID!, response_type: "code", owner: "user", redirect_uri: redirectUri("notion"), state,
    }).toString();
    return u.toString();
  },
  async exchange(code) {
    const basic = Buffer.from(`${config.NOTION_CLIENT_ID}:${config.NOTION_CLIENT_SECRET}`).toString("base64");
    const r = await json<{ access_token: string }>(`${API}/oauth/token`, {
      method: "POST",
      headers: { ...H, authorization: `Basic ${basic}` },
      body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri("notion") }),
    });
    return { accessToken: r.access_token }; // Notion tokens don't expire
  },
  async listChanges(auth, cursor) {
    const st = cursor?.startsWith("{") ? (JSON.parse(cursor) as { w: string | null; n: string | null; p: string | null }) : { w: cursor, n: null, p: null };
    const r = await json<{ results: Page[]; has_more: boolean; next_cursor: string | null }>(
      `${API}/search`,
      {
        method: "POST", headers: H,
        body: JSON.stringify({
          filter: { property: "object", value: "page" },
          sort: { direction: "descending", timestamp: "last_edited_time" },
          page_size: 50, ...(st.p ? { start_cursor: st.p } : {}),
        }),
      },
      auth,
    );
    const docs: DocRef[] = [];
    let newest = st.n;
    let caughtUp = false;
    for (const p of r.results) {
      if (st.w && p.last_edited_time <= st.w) { caughtUp = true; break; }
      if (!newest || p.last_edited_time > newest) newest = p.last_edited_time;
      if (!p.archived) docs.push({ id: p.id, name: titleOf(p), mimeType: "text/plain" });
    }
    if (caughtUp || !r.has_more) return { docs, cursor: newest ?? st.w, done: true };
    return { docs, cursor: JSON.stringify({ w: st.w, n: newest, p: r.next_cursor }), done: false };
  },
  async fetchDoc(auth, doc) {
    const lines: string[] = [];
    let seen = 0;
    const walk = async (id: string, depth: number): Promise<void> => {
      let start: string | null = null;
      do {
        const q: string = `page_size=100${start ? `&start_cursor=${encodeURIComponent(start)}` : ""}`;
        const r: { results: Block[]; has_more: boolean; next_cursor: string | null } = await json(`${API}/blocks/${id}/children?${q}`, { headers: H }, auth);
        for (const b of r.results) {
          if (++seen > MAX_BLOCKS) return;
          const rich = b[b.type]?.rich_text as Rich | undefined;
          const line = rich?.map((x) => x.plain_text).join("");
          if (line) lines.push(`${"  ".repeat(depth)}${line}`);
          if (b.has_children && depth < MAX_DEPTH && b.type !== "child_page") await walk(b.id, depth + 1);
        }
        start = r.has_more ? r.next_cursor : null;
      } while (start);
    };
    await walk(doc.id, 0);
    if (!lines.length) return null;
    return { name: doc.name, mimeType: "text/plain", data: `# ${doc.name}\n\n${lines.join("\n")}` };
  },
};
