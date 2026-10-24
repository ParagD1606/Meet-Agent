import { config } from "../../config";
import { htmlToText } from "../../memory/ingest";
import { json, redirectUri, toAuth, type DocRef, type SyncAuth, type SyncProvider, type SyncProviderId } from "../types";

const TOKEN = "https://oauth2.googleapis.com/token";
const BACKFILL_DAYS = 90; // first sync only looks this far back
const PAGE = 50;

const tokenCall = (body: Record<string, string>) =>
  json<{ access_token: string; refresh_token?: string; expires_in?: number }>(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID!, client_secret: config.GOOGLE_CLIENT_SECRET!, ...body }),
  });

/** OAuth plumbing shared by the per-user Google sources (the user connects their own account; chunks are tagged user_X by the sync runner). */
const google = (id: SyncProviderId, scope: string): Pick<SyncProvider, "id" | "configured" | "authUrl" | "exchange" | "refresh"> => ({
  id,
  configured: () => Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
  authUrl(state) {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.search = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri(id), response_type: "code", state, scope, access_type: "offline", prompt: "consent",
    }).toString();
    return u.toString();
  },
  async exchange(code) {
    return toAuth(await tokenCall({ grant_type: "authorization_code", code, redirect_uri: redirectUri(id) }));
  },
  async refresh(auth: SyncAuth) {
    if (!auth.refreshToken) throw new Error(`no refresh token; reconnect ${id}`);
    return toAuth(await tokenCall({ grant_type: "refresh_token", refresh_token: auth.refreshToken }), auth);
  },
});

// ---------- Gmail ----------
const GM = "https://gmail.googleapis.com/gmail/v1/users/me";
type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] };
const b64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const find = (p: Part, mime: string): string | null => {
  if (p.mimeType === mime && p.body?.data) return b64(p.body.data);
  for (const c of p.parts ?? []) { const r = find(c, mime); if (r) return r; }
  return null;
};

/**
 * Personal Gmail (gmail.readonly). Cursor: epoch-seconds watermark of when the previous listing started (minus 5 min overlap),
 * or while paging JSON `{w,n,p}` = watermark, this run's start, Gmail pageToken. Messages are immutable, so one doc per message.
 * Selection is `{ids:["*"], scopeTag:"user_X"}`, set when the user connects.
 */
export const gmail: SyncProvider = {
  ...google("gmail", "https://www.googleapis.com/auth/gmail.readonly"),
  async listChanges(auth, cursor) {
    const st = cursor?.startsWith("{") ? (JSON.parse(cursor) as { w: number; n: number; p: string | null }) : null;
    const w = st?.w ?? (cursor ? Number(cursor) : Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 86400);
    const n = st?.n ?? Math.floor(Date.now() / 1000) - 300;
    const q = new URLSearchParams({ q: `after:${w} -in:spam -in:trash -category:promotions`, maxResults: String(PAGE), ...(st?.p ? { pageToken: st.p } : {}) });
    const r = await json<{ messages?: { id: string }[]; nextPageToken?: string }>(`${GM}/messages?${q}`, undefined, auth);
    const docs: DocRef[] = (r.messages ?? []).map((m) => ({ id: m.id, name: m.id, mimeType: "text/plain" }));
    if (r.nextPageToken) return { docs, cursor: JSON.stringify({ w, n, p: r.nextPageToken }), done: false };
    return { docs, cursor: String(n), done: true };
  },
  async fetchDoc(auth, doc) {
    const m = await json<{ id: string; payload: Part }>(`${GM}/messages/${doc.id}?format=full`, undefined, auth);
    const h = (k: string) => m.payload.headers?.find((x) => x.name.toLowerCase() === k)?.value ?? "";
    const body = find(m.payload, "text/plain") ?? htmlToText(find(m.payload, "text/html") ?? "");
    if (!body.trim()) return null;
    const subject = h("subject") || "(no subject)";
    return {
      name: `Email: ${subject}`, mimeType: "text/plain", permalink: `https://mail.google.com/mail/u/0/#all/${m.id}`,
      data: `Email "${subject}"\nFrom: ${h("from")}\nTo: ${h("to")}\nDate: ${h("date")}\n\n${body.trim()}`,
    };
  },
};

// ---------- Calendar ----------
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
type Ev = {
  id: string; status?: string; summary?: string; description?: string; location?: string; updated: string; htmlLink?: string;
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string }[];
};

/**
 * Personal Google Calendar (calendar.readonly), primary calendar. Cursor: ISO watermark of the newest event `updated`, or while
 * paging JSON `{w,n,p}`. Cancelled events are skipped (not removed from memory). RSVP/response status is not ingested.
 */
export const gcal: SyncProvider = {
  ...google("gcal", "https://www.googleapis.com/auth/calendar.readonly"),
  async listChanges(auth, cursor) {
    const st = cursor?.startsWith("{") ? (JSON.parse(cursor) as { w: string; n: string | null; p: string | null }) : { w: cursor ?? new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString(), n: null, p: null };
    const q = new URLSearchParams({ updatedMin: st.w, singleEvents: "false", showDeleted: "false", maxResults: String(PAGE), ...(st.p ? { pageToken: st.p } : {}) });
    const r = await json<{ items: Ev[]; nextPageToken?: string }>(`${CAL}?${q}`, undefined, auth);
    let newest = st.n;
    const docs: DocRef[] = [];
    for (const e of r.items) {
      if (!newest || e.updated > newest) newest = e.updated;
      if (e.status === "cancelled") continue;
      const when = e.start?.dateTime ?? e.start?.date ?? "";
      const who = (e.attendees ?? []).map((a) => a.displayName ?? a.email).filter(Boolean).join(", ");
      const text = [`Calendar event: ${e.summary ?? "(untitled)"}`, `When: ${when}${e.end ? ` to ${e.end.dateTime ?? e.end.date}` : ""}`, e.location && `Where: ${e.location}`, who && `With: ${who}`, e.description && `\n${htmlToText(e.description).trim()}`].filter(Boolean).join("\n");
      docs.push({ id: e.id, name: `Event: ${e.summary ?? e.id}`, mimeType: "text/plain", permalink: e.htmlLink, inline: text });
    }
    if (r.nextPageToken) return { docs, cursor: JSON.stringify({ w: st.w, n: newest, p: r.nextPageToken }), done: false };
    return { docs, cursor: newest ?? st.w, done: true };
  },
  async fetchDoc(_auth, doc) {
    return doc.inline ? { name: doc.name, mimeType: "text/plain", data: doc.inline, permalink: doc.permalink } : null;
  },
};
