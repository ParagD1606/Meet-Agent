import "../slack/env";
// Replay: the App Home tab failed to publish (invalid_blocks) for some users. The view must satisfy Slack's block limits
// for any number of facts, admin or not, and any text a fact or a display name can contain.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../db";
import { memories } from "../../src/db/schema";
import { homeView } from "../../src/slack/cards";
import { handleEventCallback } from "../../src/slack/events";
import { fakeVector } from "../memory/helpers";
import { ME, boot, nextTs, teardown, type Slack } from "./harness";

type Block = Record<string, any>;
const ids = new Set<string>();

/** Slack Block Kit limits that make views.publish reject a Home view with invalid_blocks. */
export function validateHomeView(view: any): string[] {
  const bad: string[] = [];
  const err = (m: string) => bad.push(m);
  if (view.type !== "home") err("view.type must be home");
  const blocks: Block[] = view.blocks ?? [];
  if (blocks.length > 100) err(`${blocks.length} blocks (max 100)`);
  ids.clear();
  const plain = (t: any, max: number, where: string, min = 1) => {
    if (!t || t.type !== "plain_text" || typeof t.text !== "string") return err(`${where}: not plain_text`);
    if (t.text.length < min) err(`${where}: empty`);
    if (t.text.length > max) err(`${where}: ${t.text.length} chars (max ${max})`);
  };
  const button = (b: Block, where: string) => {
    if (b.type !== "button") return err(`${where}: element ${b.type}`);
    plain(b.text, 75, `${where}.text`);
    if (!b.action_id || b.action_id.length > 255) err(`${where}: action_id`);
    if (b.value !== undefined && String(b.value).length > 2000) err(`${where}: value ${String(b.value).length} chars (max 2000)`);
    if (b.url !== undefined && (!/^https?:\/\//.test(b.url) || b.url.length > 3000)) err(`${where}: url`);
    if (b.style !== undefined && !["primary", "danger"].includes(b.style)) err(`${where}: style`);
    if (b.confirm) {
      const c = b.confirm;
      plain(c.title, 100, `${where}.confirm.title`);
      if (!c.text || !["plain_text", "mrkdwn"].includes(c.text.type) || !c.text.text || c.text.text.length > 300) err(`${where}.confirm.text`);
      plain(c.confirm, 30, `${where}.confirm.confirm`);
      plain(c.deny, 30, `${where}.confirm.deny`);
    }
  };
  blocks.forEach((b, i) => {
    const w = `block[${i}] ${b.type}`;
    if (b.block_id) { if (ids.has(b.block_id) || b.block_id.length > 255) err(`${w}: block_id`); ids.add(b.block_id); }
    if (b.type === "header") plain(b.text, 150, `${w}.text`);
    else if (b.type === "section") {
      if (!b.text || typeof b.text.text !== "string" || !b.text.text.trim()) err(`${w}: empty section text`);
      else if (b.text.text.length > 3000) err(`${w}: section text ${b.text.text.length} chars (max 3000)`);
      if (b.accessory) button(b.accessory, `${w}.accessory`);
    } else if (b.type === "actions") {
      const els: Block[] = b.elements ?? [];
      if (!els.length || els.length > 25) err(`${w}: ${els.length} elements`);
      const seen = new Set<string>();
      els.forEach((e, j) => { button(e, `${w}.elements[${j}]`); if (seen.has(e.action_id)) err(`${w}: duplicate action_id ${e.action_id}`); seen.add(e.action_id); });
    } else err(`${w}: unexpected block type`);
  });
  return bad;
}

const facts = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, text: `Fact number ${i + 1}: Marlin invoices are due on the 5th, pricing is 49 dollars <@U123> & more *bold* ${"x".repeat(i % 7 === 0 ? 900 : 10)}` }));
const hostile = [
  { id: 9001, text: "" }, { id: 9002, text: "   " }, { id: 9003, text: "<<<>>>&&&" }, { id: 9004, text: "a".repeat(5000) }, { id: 9005, text: "`code` ```block``` :emoji: \n\nnewlines\n" },
];

describe("App Home view builder", () => {
  test("the validator itself catches the classic mistakes", () => {
    expect(validateHomeView({ type: "home", blocks: [{ type: "section", text: { type: "mrkdwn", text: "" } }] })).not.toEqual([]);
    expect(validateHomeView({ type: "home", blocks: [{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "a" }, action_id: "x" }, { type: "button", text: { type: "plain_text", text: "b" }, action_id: "x" }] }] })).toContain("block[0] actions: duplicate action_id x");
    expect(validateHomeView({ type: "home", blocks: [{ type: "header", text: { type: "plain_text", text: "h".repeat(151) } }] })).not.toEqual([]);
    expect(validateHomeView({ type: "home", blocks: Array.from({ length: 101 }, () => ({ type: "header", text: { type: "plain_text", text: "h" } })) })).not.toEqual([]);
  });

  for (const n of [0, 1, 150]) for (const admin of [false, true]) {
    test(`${n} facts, ${admin ? "admin" : "member"}`, () => {
      const view = homeView({ botName: "Pixel", name: "Dana Smith", connections: 3, facts: facts(n), admin });
      expect(validateHomeView(view)).toEqual([]);
      const blocks = (view as any).blocks as Block[];
      expect(blocks.some((b) => JSON.stringify(b).includes("brain_review_open"))).toBe(admin);
      expect(blocks.filter((b) => b.accessory?.action_id === "brain_home_forget").length).toBe(Math.min(n, 40));
    });
  }

  test("hostile inputs: empty / whitespace / markup-only / huge facts, odd names, max-length persona", () => {
    for (const name of [null, "", "   ", "Dana", "A".repeat(500), "<@U1> & <b>", "Zoë 日本語 🎉"]) {
      for (const f of [[], hostile, [...hostile, ...facts(150)]]) {
        for (const connections of [0, 1, 7]) {
          const view = homeView({ botName: "P".repeat(40), name, connections, facts: f, admin: true });
          expect(validateHomeView(view)).toEqual([]);
        }
      }
    }
    expect(validateHomeView(homeView({ connections: 0 }))).toEqual([]);
  });
});

describe("through the real app_home_opened path", () => {
  let slack: Slack;
  beforeEach(async () => { slack = await boot(); });
  afterAll(teardown);

  for (const [who, n] of [["UDANA", 0], ["UDANA", 1], ["UDANA", 150], ["UADMIN", 150]] as const) {
    test(`${who} with ${n} stored facts publishes a valid view`, async () => {
      const rows = facts(n);
      for (let i = 0; i < rows.length; i += 50) {
        await db.insert(memories).values(rows.slice(i, i + 50).map((f) => ({ scopeTag: `user_${who}`, text: f.text, embedding: fakeVector(f.text), kind: "fact" as const })));
      }
      await handleEventCallback({ event_id: `EvH${nextTs()}`, team_id: "T1", type: "event_callback", event: { type: "app_home_opened", user: who, tab: "home" } } as never);
      const pubs = slack.calls.filter((c) => c.method === "views.publish");
      expect(pubs).toHaveLength(1);
      expect(pubs[0]!.args.user_id).toBe(who);
      expect(validateHomeView(pubs[0]!.args.view)).toEqual([]);
      const forget = (pubs[0]!.args.view.blocks as Block[]).filter((b) => b.accessory?.action_id === "brain_home_forget").length;
      expect(forget).toBeGreaterThanOrEqual(Math.min(n, 1));
      expect(forget).toBeLessThanOrEqual(40);
    });
  }
});
