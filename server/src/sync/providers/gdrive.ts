import { config } from "../../config";
import { http, json, redirectUri, toAuth, type DocRef, type SyncProvider } from "../types";

const API = "https://www.googleapis.com/drive/v3";
const TOKEN = "https://oauth2.googleapis.com/token";
const EXPORT: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};
const DOWNLOAD = new Set(["text/plain", "text/markdown", "text/csv", "text/html", "application/pdf"]);
const supported = (m: string) => m in EXPORT || DOWNLOAD.has(m);

type DFile = { id: string; name: string; mimeType: string; trashed?: boolean; parents?: string[] };
const FILE_FIELDS = "id,name,mimeType,trashed,parents";
const toRef = (f: DFile | undefined): DocRef[] =>
  f && !f.trashed && supported(f.mimeType) ? [{ id: f.id, name: f.name, mimeType: f.mimeType, ...(f.parents ? { parents: f.parents } : {}) }] : [];

const tokenCall = (body: Record<string, string>) =>
  json<{ access_token: string; refresh_token?: string; expires_in?: number }>(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID!, client_secret: config.GOOGLE_CLIENT_SECRET!, ...body }),
  });

/**
 * Cursor: null (never synced) -> `full:<startToken>:<filesPageToken>` while listing every file
 * -> `<startToken>` (a Drive changes token) once the full listing is done -> next changes token.
 * The start token is taken *before* the full listing so edits made during it are re-seen next run.
 */
export const gdrive: SyncProvider = {
  id: "gdrive",
  configured: () => Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
  authUrl(state) {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.search = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri("gdrive"), response_type: "code", state,
      scope: "https://www.googleapis.com/auth/drive.readonly", access_type: "offline", prompt: "consent",
    }).toString();
    return u.toString();
  },
  async exchange(code) {
    return toAuth(await tokenCall({ grant_type: "authorization_code", code, redirect_uri: redirectUri("gdrive") }));
  },
  async refresh(auth) {
    if (!auth.refreshToken) throw new Error("no refresh token; reconnect Google Drive");
    return toAuth(await tokenCall({ grant_type: "refresh_token", refresh_token: auth.refreshToken }), auth);
  },
  async listChanges(auth, cursor) {
    const listFiles = async (start: string, pageToken?: string) => {
      const q = new URLSearchParams({ q: "trashed=false", pageSize: "100", fields: `nextPageToken,files(${FILE_FIELDS})` });
      if (pageToken) q.set("pageToken", pageToken);
      const r = await json<{ nextPageToken?: string; files: DFile[] }>(`${API}/files?${q}`, undefined, auth);
      return {
        docs: r.files.flatMap(toRef),
        cursor: r.nextPageToken ? `full:${start}:${r.nextPageToken}` : start,
        done: !r.nextPageToken,
      };
    };
    if (cursor === null) {
      const { startPageToken } = await json<{ startPageToken: string }>(`${API}/changes/startPageToken`, undefined, auth);
      return listFiles(startPageToken);
    }
    if (cursor.startsWith("full:")) {
      const rest = cursor.slice(5);
      const i = rest.indexOf(":");
      return listFiles(rest.slice(0, i), rest.slice(i + 1));
    }
    const q = new URLSearchParams({
      pageToken: cursor, pageSize: "100", includeRemoved: "true",
      fields: `nextPageToken,newStartPageToken,changes(removed,file(${FILE_FIELDS}))`,
    });
    const r = await json<{ nextPageToken?: string; newStartPageToken?: string; changes: { removed?: boolean; file?: DFile }[] }>(
      `${API}/changes?${q}`, undefined, auth,
    );
    const next = r.nextPageToken ?? r.newStartPageToken ?? cursor;
    // ponytail: deletions are not propagated to memory; add a removal path in memory/ingest if needed.
    return { docs: r.changes.flatMap((c) => (c.removed ? [] : toRef(c.file))), cursor: next, done: !r.nextPageToken };
  },
  async fetchDoc(auth, doc) {
    const exportAs = EXPORT[doc.mimeType];
    const res = await http(
      exportAs ? `${API}/files/${encodeURIComponent(doc.id)}/export?mimeType=${encodeURIComponent(exportAs)}` : `${API}/files/${encodeURIComponent(doc.id)}?alt=media`,
      undefined, auth,
    );
    const mimeType = exportAs ?? doc.mimeType;
    return { name: doc.name, mimeType, data: mimeType === "application/pdf" ? Buffer.from(await res.arrayBuffer()) : await res.text() };
  },
};
