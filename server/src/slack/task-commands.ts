import { cancelFollowUp, getPrefs, listFollowUps, parseDays, setPrefs, taskListMessage } from "../manager";
import { escapeSlackText } from "./format";

type Reply = { response_type: "ephemeral"; text: string; blocks?: unknown[] };
const say = (text: string, blocks?: unknown[]): Reply => ({ response_type: "ephemeral", text, ...(blocks ? { blocks } : {}) });

const HELP = [
  "`/brain-followups` list your scheduled follow-ups",
  "`/brain-followups cancel <id>` cancel one",
  "`/brain-followups digest on [HH:MM] [mon-fri|daily|mon,wed]` daily task digest DM (default off; workspace timezone, working hours)",
  "`/brain-followups digest off`",
  "`/brain-followups weekly on|off` Friday summary of follow-ups and open tasks",
].join("\n");

/** /brain-tasks and /brain-followups. Ephemeral replies only; returns null for other commands. */
export async function taskCommand(p: { command?: string; user_id?: string; text?: string }): Promise<Reply | null> {
  const userId = p.user_id;
  if (!userId) return null;
  if (p.command === "/brain-tasks") {
    const m = await taskListMessage(userId, { buttons: true });
    return say(m.text, m.blocks);
  }
  if (p.command !== "/brain-followups") return null;
  const [cmd = "", ...rest] = (p.text ?? "").trim().split(/\s+/).filter(Boolean);
  switch (cmd.toLowerCase()) {
    case "":
    case "list": {
      const prefs = await getPrefs(userId);
      const fus = await listFollowUps(userId);
      const head = `Daily digest: ${prefs.digest?.on ? `on at ${prefs.digest.time}` : "off"} | Weekly summary: ${prefs.weekly?.on ? "on" : "off"}`;
      if (!fus.length) return say(`${head}\nYou have no scheduled follow-ups.\n${HELP}`);
      return say(`${head}\n${fus.map((f) => `• \`${f.id}\` ${f.dueAt.toISOString().slice(0, 16).replace("T", " ")} UTC${f.repeatDays ? ` (every ${f.repeatDays}d)` : ""}${f.targetId ? ` with <@${f.targetId}>${f.status === "proposed" ? " (awaiting your OK)" : ""}` : ""}: ${escapeSlackText(f.text)}`).join("\n")}`);
    }
    case "cancel":
      return say(rest[0] && (await cancelFollowUp(rest[0], userId)) ? "Cancelled." : "I couldn't find an active follow-up of yours with that id.");
    case "digest": {
      if (rest[0]?.toLowerCase() === "off") { await setPrefs(userId, { digest: { on: false, time: "09:00", days: [1, 2, 3, 4, 5] } }); return say("Daily task digest is off."); }
      if (rest[0]?.toLowerCase() !== "on") return say(HELP);
      const time = rest.find((x) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(x));
      const hhmm = time ? time.padStart(5, "0") : "09:00";
      const days = parseDays(rest.filter((x) => x !== time && x.toLowerCase() !== "on").join(" "));
      await setPrefs(userId, { digest: { on: true, time: hhmm, days }, lastDigest: undefined });
      return say(`Daily task digest on: ${hhmm} (workspace timezone) on ${days.length === 7 ? "every day" : days.length === 5 && days.join() === "1,2,3,4,5" ? "weekdays" : `${days.length} day(s)`}. I only DM during working hours and only tasks you can read.`);
    }
    case "weekly": {
      const on = rest[0]?.toLowerCase();
      if (on !== "on" && on !== "off") return say(HELP);
      await setPrefs(userId, { weekly: { on: on === "on" }, lastWeekly: undefined });
      return say(`Weekly follow-up summary is ${on}.`);
    }
    default:
      return say(HELP);
  }
}
