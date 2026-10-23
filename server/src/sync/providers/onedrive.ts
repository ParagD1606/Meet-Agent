import { config } from "../../config";
import { http, json, redirectUri, toAuth, type DocRef, type SyncProvider } from "../types";

const GRAPH = "https://graph.microsoft.com/v1.0";
const AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0";
const SCOPE = "offline_access Files.Read.All";
const TEXTY = /\.(md|markdown|txt|csv|html?)$/i;

type Item = { id: string; name: string; deleted?: unknown; file?: { mimeType?: string }; parentReference?: { id?: string } };
const mimeOf = (i: Item) => {
  const m = i.file?.mimeType ?? "";
  if (m.startsWith("text/") || m === "application/pdf") return m;
  return TEXTY.test(i.name) ? (/\.md|\.markdown/i.test(i.name) ? "text/markdown" : "text/plain") : null;
};

const tokenCall = (body: Record<string, string>) =>
  json<{ access_token: string; refresh_token?: string; expires_in?: number }>(`${AUTH}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.MS_CLIENT_ID!, client_secret: config.MS_CLIENT_SECRET!, scope: SCOPE, ...body }),
  });

/**
 * Cursor is a Graph delta URL: a `nextLink` mid-listing, the `deltaLink` once caught up.
 * Only graph.microsoft.com URLs are followed so a poisoned cursor can't leak the bearer token elsewhere.
 * ponytail: personal/default drive only; SharePoint libraries need one delta cursor per site drive.
 */
export const onedrive: SyncProvider = {
  id: "onedrive",
  configured: () => Boolean(config.MS_CLIENT_ID && config.MS_CLIENT_SECRET),
  authUrl(state) {
    const u = new URL(`${AUTH}/authorize`);
    u.search = new URLSearchParams({
      client_id: config.MS_CLIENT_ID!, response_type: "code", redirect_uri: redirectUri("onedrive"), scope: SCOPE, state, response_mode: "query",
    }).toString();
    return u.toString();
  },
  async exchange(code) {
    return toAuth(await tokenCall({ grant_type: "authorization_code", code, redirect_uri: redirectUri("onedrive") }));
  },
  async refresh(auth) {
    if (!auth.refreshToken) throw new Error("no refresh token; reconnect OneDrive");
    return toAuth(await tokenCall({ grant_type: "refresh_token", refresh_token: auth.refreshToken }), auth);
  },
  async listChanges(auth, cursor) {
    const url = cursor ?? `${GRAPH}/me/drive/root/delta`;
    if (!url.startsWith(`${GRAPH}/`)) throw new Error("invalid onedrive cursor");
    const r = await json<{ value: Item[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(url, undefined, auth);
    const docs: DocRef[] = [];
    for (const i of r.value) {
      const mime = i.file && !i.deleted ? mimeOf(i) : null;
      if (mime) docs.push({ id: i.id, name: i.name, mimeType: mime, ...(i.parentReference?.id ? { parents: [i.parentReference.id] } : {}) });
    }
    const next = r["@odata.nextLink"];
    return { docs, cursor: next ?? r["@odata.deltaLink"] ?? cursor, done: !next };
  },
  async fetchDoc(auth, doc) {
    const res = await http(`${GRAPH}/me/drive/items/${encodeURIComponent(doc.id)}/content`, undefined, auth);
    return { name: doc.name, mimeType: doc.mimeType, data: doc.mimeType === "application/pdf" ? Buffer.from(await res.arrayBuffer()) : await res.text() };
  },
};
