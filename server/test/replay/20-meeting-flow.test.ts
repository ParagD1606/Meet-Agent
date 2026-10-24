import "../slack/env";
// Replay: a meeting ends and the notes are generated. Real handlers + real Postgres, fake Slack, a scripted analysis model (a live twin runs under LIVE_MODEL=1).
// huddle file -> meeting row -> tasks (commitments) with owner / assigner / due / priority / scope / permalink -> memory (facts, decision, episode)
// -> ONE recap DM per person with tasks -> buttons -> idempotent re-analysis -> private channel / extension rules -> failed DM retry -> approve mode.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, like } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { commitments, meetings, meetingTaskNotifications, memories, episodes, settings } from "../../src/db/schema";
import { createSession } from "../../src/auth/session";
import { insertCommitment } from "../../src/manager/commitments";
import { syncTasksFromMemory } from "../../src/manager/task-sync";
import { ingestHuddleFile } from "../../src/meetings";
import { sendMeetingRecaps } from "../../src/meetings/recap";
import { setMemoryLlm } from "../../src/memory/llm";
import { EXTRACT_SYSTEM } from "../../src/memory/writeback";
import { mountRoutes } from "../../src/routes";
import { handleInteraction } from "../../src/slack/interactions";
import { DERP, ME, PARAG, PRIV, PUB, boot, eventually, liveTest, scriptedTest, send, teardown, type Slack } from "./harness";

const app = new Hono();
mountRoutes(app);
const EVE = "UEVE";
const END = Math.floor(Date.UTC(2026, 9, 24, 10, 30) / 1000); // Saturday 2026-10-24
const LINES = [
  "Dana: Okay let's plan the Tales launch for next week.",
  "Parag: I'll send the revised deck to Acme by Friday, it's urgent.",
  "Dana: Eve, you take the launch checklist by next Wednesday.",
  "Eve: Sure, I will do that.",
  "Dana: We could maybe redo the logo at some point.",
  "Dana: Someone should check the venue contract.",
  "Dana: Who is paying for the venue? Nobody knows yet.",
  "Dana: Let's go with the annual plan for the pilot.",
  "Dana: Manas will handle the advertisements.",
];
const file = (id: string, channel: string, lines: string[]) => ({
  id, title: ":headphones: Huddle notes: 10/24/26", channels: [channel], user: ME, permalink: `https://acme.slack.com/files/${id}`,
  huddle_participant_ids: [ME, PARAG, EVE], huddle_date_start: END - 1800, huddle_date_end: END,
  huddle_transcription: { lines: lines.map((l) => ({ speaker_name: l.split(":")[0], text: l.slice(l.indexOf(":") + 2) })) },
});
const task = (o: Record<string, unknown>) => ({ description: "", assigneeName: null, assigneeId: null, dueDate: null, kind: "commitment", label: "confirmed", confidence: 0.9, priority: "normal", followUp: false, reason: "", evidence: [], ...o });
const V1 = () => ({
  summary: "## Discussion\n- Tales launch planning: deck and checklist owners agreed\n- The annual plan was chosen for the pilot\n- The staging api key: sk-abcdef0123456789abcdef was shared by mistake\n## Open questions\n- Who is paying for the venue?",
  decisions: [{ text: "Use the annual plan for the pilot", quote: "Let's go with the annual plan for the pilot", confidence: 0.9, evidence: [8] }],
  tasks: [
    task({ title: "Send the revised deck to Acme", assigneeName: "Parag", assigneeId: PARAG, dueDate: "2026-10-30", confidence: 0.95, priority: "urgent", quote: "I'll send the revised deck to Acme by Friday", evidence: [2] }),
    task({ title: "Prepare the launch checklist", assigneeName: "Eve", assigneeId: EVE, dueDate: "2026-10-28", quote: "Eve, you take the launch checklist by next Wednesday", evidence: [3] }),
    task({ title: "Redo the logo", kind: "suggestion", label: "suggestion", confidence: 0.3, quote: "We could maybe redo the logo at some point" }),
    task({ title: "Check the venue contract", confidence: 0.5, quote: "Someone should check the venue contract" }),
    task({ title: "Handle the advertisements", assigneeName: "Manas", quote: "Manas will handle the advertisements" }),
  ],
  questions: [{ text: "Who is paying for the venue?", quote: "Who is paying for the venue", evidence: [7] }],
});

let slack: Slack;
let files: Record<string, any>;
let script: () => unknown;
const fail = { on: false };
let seq = 1_700_000_000;

beforeEach(async () => {
  files = { FH1: file("FH1", PUB, LINES) };
  script = V1;
  fail.on = false;
  slack = await boot({
    slackResponses: {
      "files.info": (a) => ({ ok: true, file: files[a.file] }),
      "chat.postMessage": (a) => { if (fail.on) throw new Error("slack is down"); return { ok: true, ts: `${++seq}.0001`, channel: a.channel }; },
    },
  });
  setMemoryLlm(async (a) => {
    if (a.system.includes("meeting source material")) return JSON.stringify(script());
    if (a.system.includes("Summarise this Slack thread")) return "The team planned the Tales launch and chose the annual plan for the pilot, with owners and due dates.";
    if (a.system === EXTRACT_SYSTEM) return JSON.stringify({ facts: [] });
    return '{"superseded":[],"facts":[],"commitments":[]}';
  });
});
afterAll(teardown);

const cookie = async (id: string) => `brain_session=${await createSession(null, id)}`;
const get = async (path: string, id: string) => app.request(path, { headers: { cookie: await cookie(id) } });
const call = async (method: string, path: string, id: string, body?: unknown) => app.request(path, { method, headers: { cookie: await cookie(id), "content-type": "application/json", "x-requested-with": "fetch" }, body: body === undefined ? undefined : JSON.stringify(body) });
const apiTasks = async (id: string) => ((await (await get("/api/tasks", id)).json()) as any).tasks as any[];
const dms = (u: string) => slack.posts().filter((p) => p.method === "chat.postMessage" && p.channel === `D_${u}`);
const blocksText = (p: { blocks?: any[] }) => JSON.stringify(p.blocks ?? []);
const actionIds = (p: { blocks?: any[] }) => (p.blocks ?? []).filter((b) => b.type === "actions").flatMap((b) => b.elements.map((e: any) => e.action_id));
const meetingRows = () => db.select().from(commitments).where(eq(commitments.sourceType, "meeting"));
const huddleEvent = (id = "FH1", channel = PUB) => ({ event_id: `EvH${++seq}`, team_id: "T1", type: "event_callback", event: { type: "file_shared", file_id: id, channel_id: channel } });
const click = (user: string, action_id: string, value: string) => handleInteraction({ type: "block_actions", user: { id: user }, actions: [{ action_id, value }] });
const noteFor = async (taskUser: string, title: string) => {
  const [m] = await db.select().from(meetings);
  const item = (m!.tasks as any[]).find((t) => t.title === title);
  const [n] = await db.select().from(meetingTaskNotifications).where(and(eq(meetingTaskNotifications.taskId, item.id), eq(meetingTaskNotifications.recipientUserId, taskUser)));
  return { m: m!, item, note: n! };
};

describe("auto mode (the default): no click needed", () => {
  scriptedTest("a fresh database behaves as auto with a 0.6 threshold", async () => {
    expect(await db.select().from(settings)).toEqual(expect.not.arrayContaining([expect.objectContaining({ key: "meeting_task_approval" })]));
    const r = (await (await get("/api/settings/meetings", "UADMIN")).json()) as any;
    expect(r).toEqual({ mode: "auto", autoConfidence: 0.6 });
  });

  scriptedTest("huddle ends: tasks, memory and one recap DM per person happen with no click", async () => {
    await send(huddleEvent());
    const [m] = await db.select().from(meetings);
    expect(m).toMatchObject({ status: "ready", organizerId: ME, channelId: PUB, sourceUrl: "https://acme.slack.com/files/FH1" });
    const items = m!.tasks as any[];

    // --- Tasks: only the two confident, owned, verified commitments became real tasks
    const rows = await meetingRows();
    expect(rows.map((r) => r.text).sort()).toEqual(["Prepare the launch checklist", "Send the revised deck to Acme"]);
    const deck = rows.find((r) => r.text.startsWith("Send"))!;
    const deckItem = items.find((i) => i.title.startsWith("Send"));
    expect(deck).toMatchObject({ ownerId: PARAG, assignerId: ME, priority: "urgent", scopeTag: "shared", channelId: PUB, status: "open", sourceRef: `meeting:${m!.id}:${deckItem.id}` });
    expect(deck.dueAt!.toISOString().slice(0, 10)).toBe("2026-10-30");
    expect(deck.permalink).toContain(`/meetings?meeting=${m!.id}`);
    expect(deckItem).toMatchObject({ approval: "approved", approvedBy: "auto", commitmentId: deck.id, kind: "commitment", unverified: false, evidence: [2] });
    expect(rows.find((r) => r.ownerId === EVE)!.dueAt!.toISOString().slice(0, 10)).toBe("2026-10-28");
    // suggestion, ownerless, unknown-owner items and the question are listed, never tasks
    const held = items.filter((i) => i.approval === "proposed").map((i) => i.title).sort();
    expect(held).toEqual(["Check the venue contract", "Handle the advertisements", "Redo the logo", "Who is paying for the venue?"]);
    expect(items.find((i) => i.itemType === "question")).toMatchObject({ kind: "question", approval: "proposed" });
    expect(items.find((i) => i.title === "Check the venue contract")).toMatchObject({ kind: "suggestion" }); // "Someone should" is a hedge: the cue pass downgraded the model
    expect(items.find((i) => i.title === "Handle the advertisements").ambiguity.ownerMissing).toBe(true);
    // the Tasks tab (scope filtered, any member) shows them with the meeting source
    const tasks = await apiTasks(EVE);
    expect(tasks.filter((t) => t.sourceType === "meeting")).toHaveLength(2);
    expect((await apiTasks(PARAG)).find((t) => t.id === deck.id)).toMatchObject({ title: "Send the revised deck to Acme", sourceType: "meeting", ownerId: PARAG });

    // --- Memory: task facts in step, the decision as a decision fact with the meeting link, one summary episode
    for (const r of rows) expect((await db.select().from(memories).where(and(eq(memories.sourceRef, `task:${r.id}`), eq(memories.status, "active")))).length).toBe(1);
    const dec = await db.select().from(memories).where(eq(memories.sourceRef, `meeting-decision:${m!.id}`));
    expect(dec).toHaveLength(1);
    expect(dec[0]).toMatchObject({ factType: "decision", scopeTag: "shared", status: "active" });
    expect(dec[0]!.permalink).toContain(`/meetings?meeting=${m!.id}`);
    expect((await db.select().from(episodes).where(eq(episodes.threadTs, "huddle_FH1"))).map((e) => e.scopeTag)).toEqual(["shared"]);

    // --- DMs (detached): exactly one per person who has a task, plus the organizer's "who owns" card; nothing for Derp, nothing in the channel
    await eventually(async () => dms(PARAG).length === 1 && dms(EVE).length === 1 && dms(ME).length === 1);
    expect(dms(DERP)).toHaveLength(0);
    expect(slack.to(PUB)).toHaveLength(0);
    const [pd] = dms(PARAG);
    const pt = blocksText(pd!);
    expect(pd!.blocks![0]).toMatchObject({ type: "header" });
    expect(pd!.blocks![0].text.text).toBe("Meeting recap: Huddle in #general · Oct 24 (Sat, Oct 24, 30 min)");
    expect(pt).toContain("What happened");
    expect(pt).toContain("Decision: Use the annual plan for the pilot");
    expect(pt).toContain("Open question: Who is paying for the venue?");
    expect(pt).toContain("Send the revised deck to Acme");
    expect(pt).toContain("URGENT");
    expect(pt).toContain("Fri, Oct 30");
    expect(pt).not.toContain("launch checklist"); // only THEIR tasks
    expect(pt).not.toContain("sk-abcdef");          // nothing that looks like a secret
    expect(actionIds(pd!)).toEqual(expect.arrayContaining(["meeting_task_ack", "meeting_task_done", "meeting_task_decline", "meeting_link"]));
    expect(pt).toContain(`/meetings?meeting=${m!.id}`);
    expect(pd!.blocks!.length).toBeLessThanOrEqual(50);
    expect(blocksText(dms(EVE)[0]!)).toContain("launch checklist");
    const od = blocksText(dms(ME)[0]!);
    expect(od).toContain('Who owns \\"Handle the advertisements\\"?'); // the unresolved owner goes to the organizer, as a card
    expect(od).not.toContain("Redo the logo");                         // low confidence items are listed on the page, not DMed
    expect(actionIds(dms(ME)[0]!)).toEqual(expect.arrayContaining(["meeting_item_reject", "meeting_link"]));
    // audit: the auto approvals are recorded as such
    const audit = ((await (await get(`/api/meetings/${m!.id}/audit`, "UADMIN")).json()) as any).audit as any[];
    expect(audit.filter((a) => a.action === "approve" && a.detail.approvedBy === "auto")).toHaveLength(3); // two tasks + the decision
  });

  scriptedTest("buttons update the commitment and the notification, and tell the organizer", async () => {
    await ingestHuddleFile("FH1");
    await eventually(async () => dms(PARAG).length === 1 && dms(EVE).length === 1);
    const deck = await noteFor(PARAG, "Send the revised deck to Acme");
    await click(PARAG, "meeting_task_ack", deck.note.id);
    expect((await noteFor(PARAG, "Send the revised deck to Acme")).note.status).toBe("acknowledged");
    expect((await db.select().from(commitments).where(eq(commitments.id, deck.item.commitmentId)))[0]!.status).toBe("open");
    // someone else cannot press Parag's button
    await click(EVE, "meeting_task_done", deck.note.id);
    expect((await db.select().from(commitments).where(eq(commitments.id, deck.item.commitmentId)))[0]!.status).toBe("open");

    slack.reset();
    await click(PARAG, "meeting_task_done", deck.note.id);
    const done = (await db.select().from(commitments).where(eq(commitments.id, deck.item.commitmentId)))[0]!;
    expect(done.status).toBe("done");
    expect(dms(ME).some((p) => /completed: Send the revised deck/.test(p.text))).toBe(true); // the assigner (organizer) is told
    const edited = slack.posts().find((p) => p.method === "chat.update" && p.channel === `D_${PARAG}`);
    expect(JSON.stringify(edited!.blocks)).toContain("Done");
    expect(actionIds(edited!)).not.toContain("meeting_task_done"); // buttons give way to the outcome

    const eve = await noteFor(EVE, "Prepare the launch checklist");
    slack.reset();
    await click(EVE, "meeting_task_decline", eve.note.id);
    const [cm] = await db.select().from(commitments).where(eq(commitments.id, eve.item.commitmentId));
    expect(cm).toMatchObject({ ownerId: null, ownerName: null, status: "open" });
    expect((await noteFor(EVE, "Prepare the launch checklist")).note.status).toBe("declined");
    const now = (await noteFor(EVE, "Prepare the launch checklist")).item;
    expect(now).toMatchObject({ assigneeId: null });
    const notice = dms(ME).find((p) => /not theirs/.test(p.text));
    expect(notice!.text).toContain("Prepare the launch checklist");
    expect(blocksText(notice!)).toContain("/tasks"); // reassign hint
  });

  scriptedTest("re-sync and re-analysis never duplicate tasks or DMs; a changed version adds only the new task", async () => {
    await ingestHuddleFile("FH1");
    await eventually(async () => dms(PARAG).length === 1 && dms(EVE).length === 1 && dms(ME).length === 1);
    const eve = await noteFor(EVE, "Prepare the launch checklist");
    await click(EVE, "meeting_task_decline", eve.note.id); // owners' decisions stick
    const before = (await meetingRows()).map((r) => r.id).sort();
    const sent = slack.posts().filter((p) => p.method === "chat.postMessage").length;

    await ingestHuddleFile("FH1"); await ingestHuddleFile("FH1");
    await sendMeetingRecaps((await db.select().from(meetings))[0]!.id);
    expect((await meetingRows()).map((r) => r.id).sort()).toEqual(before);
    expect((await db.select().from(commitments)).length).toBe(before.length);
    await new Promise((r) => setTimeout(r, 150));
    expect(slack.posts().filter((p) => p.method === "chat.postMessage").length).toBe(sent + 0); // not one more DM (Eve's "Not mine" stays unassigned, nobody re-announced)
    expect((await db.select().from(commitments).where(eq(commitments.id, eve.item.commitmentId)))[0]!.ownerId).toBeNull();

    // the notes change: one new task for Derp, an old one is gone from the notes
    files.FH1 = { ...file("FH1", PUB, [...LINES, "Dana: Derp, draft the press release by Monday."]), huddle_participant_ids: [ME, PARAG, EVE, DERP] };
    script = () => { const v = V1(); v.tasks.push(task({ title: "Draft the press release", assigneeName: "Derpx06", assigneeId: DERP, dueDate: "2026-10-26", quote: "Derp, draft the press release by Monday" })); return v; };
    await ingestHuddleFile("FH1");
    await eventually(async () => dms(DERP).length === 1);
    expect((await meetingRows()).length).toBe(before.length + 1);
    expect(dms(PARAG)).toHaveLength(1);
    expect(dms(EVE)).toHaveLength(1);
    const dd = blocksText(dms(DERP)[0]!);
    expect(dd).toContain("Draft the press release");
    expect(dd).not.toContain("Send the revised deck");
    // a task the new version no longer contains and nobody acknowledged is dropped; an acknowledged one is kept
    const [m] = await db.select().from(meetings);
    const deck = (m!.tasks as any[]).find((t) => t.title.startsWith("Send"));
    await click(PARAG, "meeting_task_ack", (await noteFor(PARAG, "Send the revised deck to Acme")).note.id);
    script = () => { const v = V1(); v.tasks = v.tasks.filter((t: any) => !/checklist/.test(t.title) && !/Draft/.test(t.title)); return v; };
    await ingestHuddleFile("FH1");
    expect((await db.select().from(commitments).where(eq(commitments.id, deck.commitmentId)))[0]!.status).toBe("open");
    expect((await db.select().from(commitments).where(like(commitments.text, "Draft the press%")))[0]!.status).toBe("dropped");
  });

  scriptedTest("a failed DM is retried (at most 3 attempts) and the reason is on the meeting", async () => {
    fail.on = true;
    await ingestHuddleFile("FH1");
    const [m] = await db.select().from(meetings);
    await eventually(async () => (await db.select().from(meetingTaskNotifications)).some((n) => n.status === "failed" && n.error === "slack is down"));
    const view = (await (await get(`/api/meetings/${m!.id}`, ME)).json()) as any;
    const deck = view.items.find((i: any) => i.title.startsWith("Send"));
    expect(deck.notification).toMatchObject({ status: "failed", error: "slack is down" });
    expect(deck.commitmentId).toBeTruthy();
    fail.on = false;
    const r = await sendMeetingRecaps(m!.id);
    expect(r.failed).toBe(0);
    expect(dms(PARAG)).toHaveLength(2); // the failed attempt and the retry (the fake records both calls)
    expect((await get(`/api/meetings/${m!.id}`, ME).then((x) => x.json()) as any).items.find((i: any) => i.title.startsWith("Send")).notification.status).toBe("sent");
    // a hard failure gives up after 3 attempts
    await db.update(meetingTaskNotifications).set({ status: "failed", attempts: 3, error: "x" }).where(eq(meetingTaskNotifications.recipientUserId, PARAG));
    expect((await sendMeetingRecaps(m!.id)).sent).toBe(0);
  });

  scriptedTest("private-channel huddle: tasks stay private, an outsider owner gets no summary, non-members see nothing", async () => {
    files.FH2 = file("FH2", PRIV, LINES);
    await ingestHuddleFile("FH2", PRIV);
    const [m] = await db.select().from(meetings);
    const rows = await meetingRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.scopeTag === `channel_${PRIV}`)).toBe(true);
    await eventually(async () => dms(PARAG).length === 1);
    const pt = blocksText(dms(PARAG)[0]!);
    expect(pt).toContain("Send the revised deck to Acme");   // the assignment itself is told to the person assigned
    expect(pt).not.toContain("What happened");                // PARAG is not in the private channel: no summary, no notes link
    expect(pt).not.toContain("Annual plan");
    expect(pt).not.toContain(`/meetings?meeting=${m!.id}`);
    // members of the private channel see it; others (including a workspace admin outside it) do not
    expect((await apiTasks(ME)).filter((t) => t.sourceType === "meeting")).toHaveLength(2);
    for (const outsider of [EVE, "UEVE", PARAG]) {
      expect((await apiTasks(outsider)).filter((t) => t.sourceType === "meeting")).toHaveLength(0);
      expect(((await (await get("/api/meetings", outsider)).json()) as any[]).map((x) => x.id)).not.toContain(m!.id);
      expect((await get(`/api/meetings/${m!.id}`, outsider)).status).toBe(404);
    }
    // facts are private too
    expect((await db.select().from(memories).where(eq(memories.sourceRef, `meeting-decision:${m!.id}`)))[0]!.scopeTag).toBe(`channel_${PRIV}`);
  });

  scriptedTest("extension upload: private to the uploader, no automatic DMs; the uploader can send them", async () => {
    script = () => ({ summary: "## Discussion\n- Invoices", decisions: [], tasks: [task({ title: "Send the invoice", assigneeName: "Parag", assigneeId: PARAG, dueDate: "2026-10-30", quote: "Parag will send the invoice by Friday" })], questions: [] });
    const token = ((await (await call("POST", "/api/meetings/extension-token", ME)).json()) as any).token as string;
    const res = await app.request("/ext/meetings", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-wait": "1" }, body: JSON.stringify({ externalId: "x1", platform: "meet", title: "Invoices", participants: ["Dana", "Parag"], lines: [{ speaker: "Dana", text: "Parag will send the invoice by Friday." }] }) });
    const { id } = (await res.json()) as any;
    const [row] = await meetingRows();
    expect(row).toMatchObject({ ownerId: PARAG, scopeTag: `user_${ME}`, channelId: null });
    expect((await apiTasks(ME)).filter((t) => t.sourceType === "meeting")).toHaveLength(1);
    expect((await apiTasks(PARAG)).filter((t) => t.sourceType === "meeting")).toHaveLength(0);
    expect((await apiTasks(EVE)).filter((t) => t.sourceType === "meeting")).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 150));
    expect(slack.posts().filter((p) => p.method === "chat.postMessage")).toHaveLength(0); // no automatic DM
    expect((await get(`/api/meetings/${id}`, PARAG)).status).toBe(404);
    // the uploader presses "Send task DMs"
    const sent = (await (await call("POST", `/api/meetings/${id}/recap`, ME, {})).json()) as any;
    expect(sent).toMatchObject({ sent: 1, failed: 0 });
    const t = blocksText(dms(PARAG)[0]!);
    expect(t).toContain("Send the invoice");
    expect(t).not.toContain("What happened"); // Parag cannot read the uploader's private notes
    expect((await call("POST", `/api/meetings/${id}/recap`, ME, {}).then((r) => r.json()) as any).sent).toBe(0); // never twice
  });
});

describe("auto-merge is visible", () => {
  scriptedTest("a duplicate of an existing task makes no second task, no second DM, and is flagged on the item", async () => {
    const existing = await insertCommitment({ ownerId: PARAG, ownerName: "Parag", text: "Send the revised deck to Acme", dueAt: new Date("2026-10-30T23:59:00Z"), sourceType: "message", sourceRef: "msg:old:1", channelId: PUB, scopeTag: "shared", assignerId: ME });
    await ingestHuddleFile("FH1");
    const [m] = await db.select().from(meetings);
    const deck = (m!.tasks as any[]).find((i) => i.title.startsWith("Send"));
    expect(deck).toMatchObject({ approval: "approved", merged: true, commitmentId: existing!.id });
    expect(deck.ambiguity.duplicateOf[0]).toMatchObject({ source: "task", id: existing!.id });
    expect((await meetingRows()).map((r) => r.ownerId)).toEqual([EVE]); // only the checklist is new
    await eventually(async () => dms(EVE).length === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(dms(PARAG)).toHaveLength(0); // Parag already has that task: nothing to announce again
  });
});

describe("clarification card", () => {
  scriptedTest("an unclear owner gets a 'Who owns ...?' card with candidates; the organizer's click assigns it (and only theirs)", async () => {
    files.FH1 = file("FH1", PUB, ["Dana: Paraag will send the budget by Friday."]);
    script = () => ({ summary: "## Discussion\n- budget", decisions: [], questions: [], tasks: [task({ title: "Send the budget", assigneeName: "Paraag", dueDate: "2026-10-30", quote: "Paraag will send the budget by Friday" })] });
    await ingestHuddleFile("FH1");
    const [m] = await db.select().from(meetings);
    const item = (m!.tasks as any[])[0];
    expect(item).toMatchObject({ approval: "proposed", assigneeId: null });
    expect(item.ambiguity).toMatchObject({ ownerAmbiguous: true });
    expect(item.ambiguity.ownerCandidates[0]).toMatchObject({ id: PARAG, name: "Parag" });
    await eventually(async () => dms(ME).length === 1);
    const card = dms(ME)[0]!;
    expect(blocksText(card)).toContain('Who owns \\"Send the budget\\"?');
    const values = (card.blocks ?? []).filter((b) => b.type === "actions").flatMap((b) => b.elements.filter((e: any) => e.action_id === "meeting_item_owner").map((e: any) => e.value));
    expect(values).toEqual([`${m!.id}:${item.id}:${PARAG}`]);
    expect(actionIds(card)).toContain("meeting_link"); // "Assign in console"
    await click(EVE, "meeting_item_owner", values[0]); // not the organizer: refused
    expect(await meetingRows()).toHaveLength(0);
    await click(ME, "meeting_item_owner", values[0]);
    await click(ME, "meeting_item_owner", values[0]); // idempotent
    const rows = await meetingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerId: PARAG, text: "Send the budget" });
    expect(((await db.select().from(meetings))[0]!.tasks as any[])[0]).toMatchObject({ assigneeId: PARAG, approval: "approved", approvedBy: "auto" }); // the auto rules now hold
    await eventually(async () => dms(PARAG).length === 1);
    expect(dms(PARAG)).toHaveLength(1);
  });
});

describe("backfill", () => {
  scriptedTest("old meetings get tasks without any DM; an admin can still send the recap", async () => {
    await db.insert(meetings).values({ id: "mt_old", sourceFileId: "FOLD", channelId: PUB, title: "Old huddle", transcript: "Parag: I will send the deck.", status: "ready", organizerId: ME, endedAt: new Date("2026-09-01T10:00:00Z"), summary: "## Discussion\n- the deck",
      tasks: [{ id: "mtask_old", title: "Send the deck", description: "", assigneeName: "Parag", assigneeId: PARAG, dueDate: null }, { id: "mtask_old2", title: "Unowned thing", description: "", assigneeName: null, assigneeId: null, dueDate: null }] });
    expect((await syncTasksFromMemory()).meetings).toBe(1);
    expect((await syncTasksFromMemory()).meetings).toBe(0); // idempotent
    const rows = await meetingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerId: PARAG, sourceRef: "meeting:mt_old:mtask_old", scopeTag: "shared" });
    await new Promise((r) => setTimeout(r, 150));
    expect(slack.posts().filter((p) => p.method === "chat.postMessage")).toHaveLength(0);
    expect((await sendMeetingRecaps("mt_old")).sent).toBe(0); // automatic sends leave them alone
    const sent = (await (await call("POST", "/api/meetings/mt_old/recap", "UADMIN", {})).json()) as any;
    expect(sent.sent).toBe(2); // Parag's recap and the organizer's "who owns" card for the ownerless item
    expect(dms(PARAG)).toHaveLength(1);
  });
});

describe("approve mode: nothing happens until a person approves", () => {
  const approveMode = async () => { await call("PUT", "/api/settings/meetings", "UADMIN", { mode: "approve" }); };

  scriptedTest("items are proposed: no task, no fact, no owner DM; the organizer approves in Slack or the console", async () => {
    await approveMode();
    await ingestHuddleFile("FH1");
    const [m] = await db.select().from(meetings);
    expect(await meetingRows()).toHaveLength(0);
    expect((await db.select().from(memories).where(like(memories.sourceRef, "task:%"))).length).toBe(0);
    expect((await db.select().from(memories).where(eq(memories.sourceRef, `meeting-decision:${m!.id}`))).length).toBe(0);
    await eventually(async () => dms(ME).length === 1);
    expect(dms(PARAG)).toHaveLength(0);
    expect(dms(EVE)).toHaveLength(0);
    const od = dms(ME)[0]!;
    expect(actionIds(od)).toEqual(expect.arrayContaining(["meeting_item_approve", "meeting_item_reject"]));
    const items = (m!.tasks as any[]);
    const deck = items.find((t) => t.title.startsWith("Send"));
    // an outsider cannot approve; the organizer's Approve button creates the task and then the owner is told
    await click(EVE, "meeting_item_approve", `${m!.id}:${deck.id}`);
    expect(await meetingRows()).toHaveLength(0);
    await click(ME, "meeting_item_approve", `${m!.id}:${deck.id}`);
    expect(await meetingRows()).toHaveLength(1);
    await eventually(async () => dms(PARAG).length === 1);
    expect(blocksText(dms(PARAG)[0]!)).toContain("Send the revised deck to Acme");
    expect(dms(EVE)).toHaveLength(0);

    // ambiguous items need an explicit owner (409), and a bulk approve skips them
    const ads = items.find((t) => t.title.startsWith("Handle"));
    const refused = await call("PATCH", `/api/meetings/${m!.id}/items/${ads.id}`, ME, { approval: "approved" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).error).toBe("needs_owner");
    const bulk = (await (await call("POST", `/api/meetings/${m!.id}/approve`, ME, { all: "confirmed" })).json()) as any;
    expect(bulk.approved).toHaveLength(2); // the checklist and the decision; the ownerless / suggestion / question items are skipped
    expect(bulk.skipped.map((s: any) => s.id)).toContain(ads.id);
    expect((await call("PATCH", `/api/meetings/${m!.id}/items/${ads.id}`, ME, { approval: "approved", assigneeId: DERP })).status).toBe(200);
    expect((await meetingRows()).map((r) => r.ownerId).sort()).toEqual([DERP, EVE, PARAG].sort());
    // a member who is neither organizer nor admin cannot review
    expect((await call("PATCH", `/api/meetings/${m!.id}/items/${ads.id}`, EVE, { approval: "rejected" })).status).toBe(403);
    // reject then restore
    const logo = items.find((t) => t.title === "Redo the logo");
    expect((await call("PATCH", `/api/meetings/${m!.id}/items/${logo.id}`, ME, { approval: "rejected" })).status).toBe(200);
    expect((await call("PATCH", `/api/meetings/${m!.id}/items/${logo.id}`, ME, { approval: "proposed" })).status).toBe(200);
  });

  scriptedTest("undoing an auto-assigned task (reject) drops it; promoting a suggestion applies the normal rules", async () => {
    await ingestHuddleFile("FH1");
    await eventually(async () => dms(EVE).length === 1);
    const [m] = await db.select().from(meetings);
    const checklist = (m!.tasks as any[]).find((t) => /checklist/.test(t.title));
    slack.reset();
    expect((await call("PATCH", `/api/meetings/${m!.id}/items/${checklist.id}`, ME, { approval: "rejected" })).status).toBe(200);
    expect((await db.select().from(commitments).where(eq(commitments.id, checklist.commitmentId)))[0]!.status).toBe("dropped");
    expect(dms(EVE).filter((p) => p.method === "chat.postMessage")).toHaveLength(0); // no new DM
    const logo = (m!.tasks as any[]).find((t) => t.title === "Redo the logo");
    const r = await call("PATCH", `/api/meetings/${m!.id}/items/${logo.id}`, ME, { kind: "commitment" });
    const promoted = ((await r.json()) as any).items.find((i: any) => i.id === logo.id);
    expect(promoted).toMatchObject({ kind: "commitment", label: "tentative", approval: "proposed" }); // low confidence and no owner: needs review
  });
});

describe("threshold", () => {
  const run = async (confidence: number) => {
    script = () => ({ summary: "## Discussion\n- Deck", decisions: [], questions: [], tasks: [task({ title: "Send the revised deck to Acme", assigneeName: "Parag", assigneeId: PARAG, confidence, quote: "I'll send the revised deck to Acme by Friday" })] });
    await ingestHuddleFile("FH1");
    return (await meetingRows()).length;
  };
  scriptedTest("0.59 waits for a human, 0.6 and 0.61 are assigned (threshold 0.6)", async () => {
    // the "I'll ... by Friday" words are firm, so the cue pass floors a named owner at 0.7: use a hedge-free quote with no cue to test the raw threshold
    const raw = async (confidence: number) => {
      script = () => ({ summary: "## Discussion\n- Deck", decisions: [], questions: [], tasks: [task({ title: "Send the revised deck to Acme", assigneeName: "Parag", assigneeId: PARAG, confidence, quote: "Okay let's plan the Tales launch for next week" })] });
      await ingestHuddleFile("FH1");
      return (await meetingRows()).length;
    };
    expect(await raw(0.59)).toBe(0);
    await db.delete(meetings); await db.delete(commitments);
    expect(await raw(0.6)).toBe(1);
    await db.delete(meetings); await db.delete(commitments);
    expect(await raw(0.61)).toBe(1);
    await db.delete(meetings); await db.delete(commitments);
    await call("PUT", "/api/settings/meetings", "UADMIN", { autoConfidence: 0.8 });
    expect(await raw(0.7)).toBe(0);
    await db.delete(meetings); await db.delete(commitments);
    await call("PUT", "/api/settings/meetings", "UADMIN", { autoConfidence: 0.6 });
    expect(await run(0.5)).toBe(1); // firm words with a named owner are floored by the calibration pass
  });
});

describe("live model", () => {
  liveTest("the real model reads the huddle: owned commitments become tasks and DMs, hedges and ownerless items wait", async () => {
    setMemoryLlm(null); // the real model for the final pass (embeddings stay the deterministic local ones)
    await ingestHuddleFile("FH1");
    const rows = await meetingRows();
    expect(rows.map((r) => r.ownerId).sort()).toEqual([EVE, PARAG].sort());
    expect(rows.find((r) => r.ownerId === PARAG)!.dueAt!.toISOString().slice(0, 10)).toBe("2026-10-30");
    const [m] = await db.select().from(meetings);
    expect((m!.tasks as any[]).filter((i) => i.itemType === "task" && i.approval === "proposed").every((i) => i.kind !== "commitment" || !i.assigneeId)).toBe(true);
    await eventually(async () => dms(PARAG).length === 1 && dms(EVE).length === 1, 15_000);
    expect(dms(DERP)).toHaveLength(0);
    expect(actionIds(dms(PARAG)[0]!).filter((a) => a === "meeting_task_ack")).toHaveLength(1); // only THEIR task has buttons
  }, 300_000);
});
