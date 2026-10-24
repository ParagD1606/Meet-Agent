import { json, type DocRef, type SyncProvider } from "../types";

const API = "https://api.linear.app/graphql";
const QUERY = `query($after:String,$since:DateTimeOrDuration){issues(first:50,after:$after,filter:{updatedAt:{gt:$since}},orderBy:updatedAt){
nodes{identifier title description updatedAt url team{key} comments(first:30){nodes{body user{name}}}} pageInfo{hasNextPage endCursor}}}`;

type Node = { identifier: string; title: string; description?: string | null; updatedAt: string; url: string; team?: { key: string }; comments?: { nodes: { body: string; user?: { name: string } | null }[] } };

/**
 * API-key auth (admin pastes a Linear personal API key). Selection ids are team keys ("*" = all teams). Ingests title,
 * description and comments; status/assignee/priority are live state and are NOT ingested.
 * Cursor: ISO watermark, or while paging JSON `{w,n,p}` = watermark, newest seen, Linear's endCursor (results are newest-first).
 */
export const linear: SyncProvider = {
  id: "linear",
  configured: () => true,
  authUrl() { throw new Error("Linear connects with an API key"); },
  async exchange() { throw new Error("Linear connects with an API key"); },
  async listChanges(auth, cursor) {
    const st = cursor?.startsWith("{") ? (JSON.parse(cursor) as { w: string | null; n: string | null; p: string | null }) : { w: cursor, n: null, p: null };
    const r = await json<{ data?: { issues: { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }; errors?: { message: string }[] }>(API, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth.accessToken },
      body: JSON.stringify({ query: QUERY, variables: { after: st.p, since: st.w ?? "1970-01-01T00:00:00Z" } }),
    });
    if (!r.data) throw new Error(`linear graphql: ${r.errors?.[0]?.message ?? "no data"}`);
    const { nodes, pageInfo } = r.data.issues;
    let newest = st.n;
    const docs: DocRef[] = nodes.map((n) => {
      if (!newest || n.updatedAt > newest) newest = n.updatedAt;
      const discussion = (n.comments?.nodes ?? []).filter((c) => c.body.trim()).map((c) => `${c.user?.name ?? "someone"}: ${c.body.trim()}`);
      const text = `# ${n.identifier} ${n.title}\n\n${n.description?.trim() ?? ""}${discussion.length ? `\n\nDiscussion:\n${discussion.join("\n\n")}` : ""}`;
      return { id: n.identifier, name: `${n.identifier} ${n.title}`, mimeType: "text/markdown", parents: n.team ? [n.team.key] : [], permalink: n.url, inline: text };
    });
    if (!pageInfo.hasNextPage) return { docs, cursor: newest ?? st.w, done: true };
    return { docs, cursor: JSON.stringify({ w: st.w, n: newest, p: pageInfo.endCursor }), done: false };
  },
  async fetchDoc(_auth, doc) {
    return doc.inline ? { name: doc.name, mimeType: "text/markdown", data: doc.inline, permalink: doc.permalink } : null;
  },
};
