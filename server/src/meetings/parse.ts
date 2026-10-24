import { hasSecret } from "../memory/ambient";
import { redactSecrets } from "../memory/budget";

/**
 * Turns an uploaded transcript (txt "Name: text", "[hh:mm(:ss)] Name: text", WebVTT with <v Name>, SRT, JSON, AMI-like "A: text",
 * or plain paragraphs) into caption lines. Same rules as the browser extension's parseTranscript, plus limits and a secret scrub.
 */
export type Line = { speaker: string; text: string };
export type Format = "txt" | "vtt" | "srt" | "json" | "auto";
export const MAX_LINES = 20_000;
export const MAX_LINE_CHARS = 4_000;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const TIME = /^\[?\(?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\]?\)?\s*[-–]?\s*/;
const CUE = /-->/;

function scrub(text: string): string {
  if (!hasSecret(text)) return text;
  const r = redactSecrets(text);
  return hasSecret(r) ? "[removed: looked like a secret]" : r;
}

function fromJson(raw: string): Line[] | null {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  const arr = Array.isArray(data) ? data : data && typeof data === "object" ? ((data as any).lines ?? (data as any).transcript ?? (data as any).segments ?? (data as any).captions) : null;
  if (!Array.isArray(arr)) return null;
  const out: Line[] = [];
  for (const l of arr) {
    if (typeof l === "string") { out.push(...parseText(l)); continue; }
    if (!l || typeof l !== "object") continue;
    const o = l as Record<string, unknown>;
    const text = [o.text, o.content, o.words, o.caption, o.contents].find((v) => typeof v === "string") as string | undefined;
    const speaker = [o.speaker, o.speaker_name, o.name, o.user, o.user_name, o.who].find((v) => typeof v === "string") as string | undefined;
    if (text?.trim()) out.push({ speaker: speaker?.trim() ?? "", text: text.trim() });
  }
  return out;
}

function parseText(raw: string): Line[] {
  const rows = raw.split(/\r?\n/).map((l) => l.trim());
  const hasSpeakers = rows.some((l) => /^(?:\[?\(?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\]?\)?\s*[-–]?\s*)?(?:[^:<>]{1,60}:\s+\S|<v\s+[^>]+>)/.test(l) && !CUE.test(l));
  if (!hasSpeakers && !/WEBVTT|-->/.test(raw)) { // plain paragraphs: one line per paragraph
    return raw.split(/\r?\n\s*\r?\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean).map((text) => ({ speaker: "", text }));
  }
  const out: Line[] = [];
  let fresh = true; // a caption cue starts a new entry even when it names no speaker
  for (let line of rows) {
    if (CUE.test(line)) { fresh = true; continue; }
    if (!line || /^WEBVTT/i.test(line) || /^\d+$/.test(line) || /^(NOTE|STYLE|REGION)\b/.test(line)) continue;
    line = line.replace(TIME, "");
    const m = /^<v(?:\.[^\s>]+)?\s+([^>]+)>(.*)$/.exec(line) ?? /^([^:<>]{1,60}):\s+(.+)$/.exec(line);
    if (m) { out.push({ speaker: m[1]!.trim(), text: m[2]!.replace(/<[^>]+>/g, "").trim() }); fresh = false; }
    else if (out.length && !fresh) out[out.length - 1]!.text += ` ${line.replace(/<[^>]+>/g, "")}`; // wrapped continuation
    else { out.push({ speaker: "", text: line.replace(/<[^>]+>/g, "") }); fresh = false; }
  }
  return out;
}

export function parseTranscript(raw: string, format: Format = "auto"): Line[] {
  const text = String(raw ?? "").replace(/^﻿/, "");
  const lines = (format === "json" || (format === "auto" && /^\s*[[{]/.test(text)) ? fromJson(text) : null) ?? parseText(text);
  return lines
    .map((l) => ({ speaker: l.speaker.slice(0, 120), text: scrub(l.text.replace(/\s+/g, " ").trim()).slice(0, MAX_LINE_CHARS) }))
    .filter((l) => l.text)
    .slice(0, MAX_LINES);
}

/** The stored transcript text: one "Speaker: text" line each. Line n (1-based) is what analysis evidence points at. */
export const linesToText = (lines: Line[]) => lines.map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join("\n");

/** Splits stored transcript text back into numbered lines for the console's evidence jumps. */
export function numberedLines(text: string): { n: number; speaker: string; text: string }[] {
  return text.split("\n").map((raw, i) => {
    const m = /^([^:\n]{1,60}):\s+(.*)$/.exec(raw);
    return { n: i + 1, speaker: m && !/^https?$/i.test(m[1]!) ? m[1]!.trim() : "", text: m && !/^https?$/i.test(m[1]!) ? m[2]! : raw };
  });
}
