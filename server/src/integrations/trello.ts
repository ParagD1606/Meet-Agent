import { call, describe, IntegrationError, last4, openToken, readIntegration, sealToken, writeIntegration, type Created, type PushPayload } from "./types";

let base = "https://api.trello.com/1";
/** Tests only: points the client at a fake Trello server. */
export const setTrelloBaseForTest = (url: string | null) => { base = url ?? "https://api.trello.com/1"; };

export type TrelloSettings = { key: string; token: string; boardId: string; listId: string; memberMap: Record<string, string> };
type Stored = Omit<TrelloSettings, "token"> & { tokenEnc: string };

export async function getTrello(): Promise<TrelloSettings | null> {
  const s = await readIntegration<Stored>("trello");
  if (!s?.tokenEnc) return null;
  const { tokenEnc, ...rest } = s;
  return { ...rest, memberMap: rest.memberMap ?? {}, token: openToken(tokenEnc) };
}

/** What the browser may see: never the token, only the key's last 4 characters. */
export async function trelloPublic() {
  const s = await getTrello();
  return s ? { configured: true, keyLast4: last4(s.key), boardId: s.boardId, listId: s.listId, memberMap: s.memberMap } : { configured: false, keyLast4: "", boardId: "", listId: "", memberMap: {} };
}

/** key / token omitted = keep the stored ones. */
export async function saveTrello(b: { key?: string; token?: string; boardId: string; listId: string; memberMap: Record<string, string> }): Promise<void> {
  const old = await getTrello();
  const token = b.token || old?.token;
  const key = b.key || old?.key;
  if (!token || !key) throw new IntegrationError("invalid", "A Trello API key and token are required");
  await writeIntegration("trello", { key, tokenEnc: sealToken(token), boardId: b.boardId, listId: b.listId, memberMap: b.memberMap } satisfies Stored);
}

const need = async (): Promise<TrelloSettings> => {
  const s = await getTrello();
  if (!s) throw new IntegrationError("not_configured", "Trello is not configured: an admin must add the API key and token under Integrations > Task boards");
  return s;
};

const tr = (s: Pick<TrelloSettings, "key" | "token">, path: string, init: RequestInit & { query?: Record<string, string> } = {}) =>
  call("Trello", base, path, { ...init, query: { ...init.query, key: s.key, token: s.token } });

export async function createCard(p: PushPayload, s?: TrelloSettings): Promise<Created> {
  const cfg = s ?? (await need());
  if (!cfg.listId) throw new IntegrationError("not_configured", "Pick a Trello list under Integrations > Task boards");
  const member = p.ownerId ? cfg.memberMap[p.ownerId] : undefined;
  const card = (await tr(cfg, "/cards", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: p.title.slice(0, 16_000), idList: cfg.listId, pos: "bottom",
      desc: describe(p, !member && p.ownerName ? [`Owner: ${p.ownerName}`] : []).slice(0, 16_000),
      ...(p.due ? { due: p.due.toISOString() } : {}), ...(member ? { idMembers: member } : {}),
    }),
  })) as { id?: string; shortUrl?: string; url?: string } | null;
  if (!card?.id) throw new IntegrationError("upstream", "Trello returned no card");
  return { id: card.id, url: card.shortUrl ?? card.url ?? "" };
}

/** Credential check that creates nothing. */
export async function testTrello(s?: { key: string; token: string }): Promise<{ username: string }> {
  const cfg = s ?? (await need());
  const me = (await tr(cfg, "/members/me", { query: { fields: "username" } })) as { username?: string } | null;
  return { username: me?.username ?? "" };
}

type Named = { id: string; name: string };
export async function trelloBoards(): Promise<Named[]> {
  const rows = (await tr(await need(), "/members/me/boards", { query: { fields: "name", filter: "open" } })) as Named[];
  return rows.map(({ id, name }) => ({ id, name }));
}
const boardId = (id: string) => { if (!/^[\w-]{1,64}$/.test(id)) throw new IntegrationError("invalid", "Invalid board id"); return id; };
export async function trelloLists(id: string): Promise<Named[]> {
  const rows = (await tr(await need(), `/boards/${boardId(id)}/lists`, { query: { fields: "name", filter: "open" } })) as Named[];
  return rows.map(({ id, name }) => ({ id, name }));
}
export async function trelloMembers(id: string): Promise<{ id: string; name: string; username: string }[]> {
  const rows = (await tr(await need(), `/boards/${boardId(id)}/members`, { query: { fields: "fullName,username" } })) as { id: string; fullName: string; username: string }[];
  return rows.map((m) => ({ id: m.id, name: m.fullName, username: m.username }));
}
