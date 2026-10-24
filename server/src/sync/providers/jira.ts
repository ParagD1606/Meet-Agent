import { json, type DocRef, type SyncProvider } from "../types";

type Field = { summary?: string; description?: unknown; updated: string; project?: { key: string }; comment?: { comments: { body: unknown; author?: { displayName: string } }[] } };
type JIssue = { key: string; fields: Field };

/** Atlassian Document Format (or a plain string) to text: concatenates text nodes, newline after block nodes. */
export function adfText(n: unknown): string {
  if (typeof n === "string") return n;
  if (!n || typeof n !== "object") return "";
  const o = n as { type?: string; text?: string; content?: unknown[] };
  const inner = (o.content ?? []).map(adfText).join("");
  return (o.text ?? "") + inner + (o.type && ["paragraph", "heading", "listItem", "codeBlock", "blockquote"].includes(o.type) ? "\n" : "");
}

// Jira JQL dates have minute resolution and are interpreted in the user's timezone; step back a day to stay safe (re-ingest is idempotent).
const jqlDate = (iso: string) => new Date(Date.parse(iso) - 86_400_000).toISOString().slice(0, 16).replace("T", " ");

/**
 * Jira Cloud with email + API token (auth.extra = {baseUrl, email}; Basic auth). Selection ids are project keys ("*" = all).
 * Ingests summary, description and comments; status/assignee/priority are live state and are NOT ingested.
 * Cursor: ISO watermark of the newest `updated` seen, or while paging JSON `{w,p}` (watermark, nextPageToken). Ascending order.
 */
export const jira: SyncProvider = {
  id: "jira",
  configured: () => true,
  authUrl() { throw new Error("Jira connects with an API token"); },
  async exchange() { throw new Error("Jira connects with an API token"); },
  async listChanges(auth, cursor, selection) {
    const base = auth.extra?.baseUrl?.replace(/\/$/, "");
    if (!base || !auth.extra?.email) throw new Error("jira source needs baseUrl and email");
    const st = cursor?.startsWith("{") ? (JSON.parse(cursor) as { w: string | null; p: string | null }) : { w: cursor, p: null };
    const ids = selection?.ids ?? [];
    const clauses = [
      ...(ids.includes("*") ? [] : [`project in (${ids.map((k) => `"${k.replace(/"/g, "")}"`).join(",")})`]),
      ...(st.w ? [`updated >= "${jqlDate(st.w)}"`] : []),
    ];
    const q = new URLSearchParams({
      jql: `${clauses.join(" AND ")} ORDER BY updated ASC`.trim(),
      fields: "summary,description,comment,updated,project", maxResults: "50", ...(st.p ? { nextPageToken: st.p } : {}),
    });
    const r = await json<{ issues: JIssue[]; nextPageToken?: string }>(`${base}/rest/api/3/search/jql?${q}`, {
      headers: { authorization: `Basic ${Buffer.from(`${auth.extra.email}:${auth.accessToken}`).toString("base64")}`, accept: "application/json" }, redirect: "error", // the token must never follow a redirect elsewhere
    });
    let newest = st.w;
    const docs: DocRef[] = [];
    for (const i of r.issues) {
      const u = new Date(i.fields.updated).toISOString();
      if (st.w && u <= st.w) continue;
      if (!newest || u > newest) newest = u;
      const discussion = (i.fields.comment?.comments ?? []).map((c) => `${c.author?.displayName ?? "someone"}: ${adfText(c.body).trim()}`).filter((l) => !l.endsWith(": "));
      const title = i.fields.summary ?? i.key;
      const text = `# ${i.key} ${title}\n\n${adfText(i.fields.description).trim()}${discussion.length ? `\n\nDiscussion:\n${discussion.join("\n\n")}` : ""}`;
      docs.push({ id: i.key, name: `${i.key} ${title}`, mimeType: "text/markdown", parents: i.fields.project ? [i.fields.project.key] : [], permalink: `${base}/browse/${i.key}`, inline: text });
    }
    if (!r.nextPageToken) return { docs, cursor: newest, done: true };
    return { docs, cursor: JSON.stringify({ w: st.w, p: r.nextPageToken }), done: false };
  },
  async fetchDoc(_auth, doc) {
    return doc.inline ? { name: doc.name, mimeType: "text/markdown", data: doc.inline, permalink: doc.permalink } : null;
  },
};
