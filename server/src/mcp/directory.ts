import { z } from "zod";
import { assertPublicUrl } from "../tools/web/ssrf";
import { PRESETS } from "./catalog";
import raw from "./directory.json";

const entrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  url: z.url().refine((u) => u.startsWith("https://"), "https only"),
  categories: z.array(z.string()).max(5),
  popularity: z.number(),
  authMethods: z.array(z.enum(["oauth", "api-key"])).min(1),
  dcr: z.boolean(),
  iconDomain: z.string().nullable(),
  note: z.string().optional(),
});
const fileSchema = z.object({ version: z.number(), entries: z.array(entrySchema) });
export type DirectoryEntry = z.infer<typeof entrySchema>;

/** Parsed at import: a malformed catalog fails loudly in CI/boot instead of mis-offering an app. */
const ENTRIES = fileSchema.parse(raw).entries;

export type ConnectMode = "oauth" | "apikey";
export type MarketItem = {
  key: string; name: string; url: string; categories: string[]; connectMode: ConnectMode;
  /** Curated preset (annotations trusted, personal-only handled). */
  curated: boolean; personalOnly: boolean; popularity: number; iconDomain: string | null;
};

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const normUrl = (u: string) => u.replace(/\/+$/, "").toLowerCase();

const presetItems: MarketItem[] = PRESETS.map((p) => ({
  key: p.key, name: p.label, url: p.url, categories: [], connectMode: p.authType === "oauth" ? "oauth" : "apikey",
  curated: true, personalOnly: !!p.personalOnly, popularity: 1e6, iconDomain: null,
}));
const presetUrls = new Set(PRESETS.map((p) => normUrl(p.url)));

const seen = new Set(presetItems.map((p) => p.key));
const dirItems: MarketItem[] = ENTRIES.filter((e) => !presetUrls.has(normUrl(e.url))).map((e) => {
  let key = slugify(e.name) || e.id;
  if (seen.has(key)) key = `${key}-${e.id}`;
  seen.add(key);
  return {
    key, name: e.name, url: e.url, categories: e.categories, curated: false, personalOnly: false,
    connectMode: e.dcr || e.authMethods.includes("oauth") ? "oauth" : "apikey", popularity: e.popularity, iconDomain: e.iconDomain,
  };
});

/** Presets first (they are the trusted, tested connectors), then the directory by popularity. */
export const MARKET: MarketItem[] = [...presetItems, ...dirItems];
export const getMarketItem = (key: string) => MARKET.find((m) => m.key === key.toLowerCase());

const terms = (q: string) => q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function score(q: string, ts: string[], m: MarketItem): number {
  const name = m.name.toLowerCase();
  let s = 0;
  if (name === q) s += 100; else if (name.startsWith(q)) s += 60; else if (name.includes(q)) s += 40;
  for (const t of ts) {
    if (name.includes(t) || m.key.includes(t)) s += 10;
    if (m.categories.some((c) => c.includes(t))) s += 4;
  }
  return s > 0 ? s + Math.min(m.popularity / 5000, 5) : 0;
}

export type DirectorySearch = { apps: MarketItem[]; totalMatches: number; truncated: boolean };

/** Empty query lists the most popular entries. Ranks name > category; popularity breaks ties. */
export function searchDirectory(query: string, limit = 10): DirectorySearch {
  const q = query.toLowerCase().trim();
  const ts = terms(q);
  const ranked = !q
    ? [...MARKET].sort((a, b) => b.popularity - a.popularity)
    : MARKET.map((m) => ({ m, s: score(q, ts, m) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s).map((r) => r.m);
  return { apps: ranked.slice(0, limit), totalMatches: ranked.length, truncated: ranked.length > limit };
}

/** Custom MCP URL gate: https, no credentials, public host (A's DNS-resolving SSRF guard). */
export async function validateCustomMcpUrl(input: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  let u: URL;
  try { u = new URL(input.trim()); } catch { return { ok: false, error: "Enter a valid MCP server URL." }; }
  if (u.protocol !== "https:") return { ok: false, error: "MCP server URL must use https." };
  if (u.username || u.password) return { ok: false, error: "MCP server URL must not include credentials." };
  try { await assertPublicUrl(u.toString()); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "MCP server URL must use a public host." }; }
  u.hash = "";
  return { ok: true, url: u.toString() };
}
