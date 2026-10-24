import type { ConnectionRow } from "./client";

/** Same app = same preset, or same custom URL. Own/org preference is decided within a group. */
export const groupKey = (c: Pick<ConnectionRow, "provider" | "url">) => (c.provider === "custom" ? `url:${c.url.replace(/\/+$/, "").toLowerCase()}` : c.provider);

/** Human name of the app a connection belongs to (the label is per-connection and may be customised, so presets use the label of the row itself). */
export const appLabel = (c: Pick<ConnectionRow, "label">) => c.label;

/** Preset key, or a readable host-based prefix for custom servers (all of which have provider "custom"). */
export function appPrefix(c: Pick<ConnectionRow, "provider" | "url">): string {
  if (c.provider !== "custom") return c.provider;
  try { return new URL(c.url).hostname.replace(/^(www|mcp|api)\./, "").replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 24); } catch { return "custom"; }
}
