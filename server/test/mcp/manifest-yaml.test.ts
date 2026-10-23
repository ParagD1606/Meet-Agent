import { expect, test } from "bun:test";
import { SLACK_SLASH_COMMANDS, SLACK_BOT_EVENTS, SLACK_BOT_SCOPES, SLACK_USER_SCOPES_SIGNIN } from "../../src/slack/manifest";

const yaml = await Bun.file(`${import.meta.dir}/../../../docs/slack-app-manifest.yaml`).text();
/** List items directly under `<key>:` (quoted scalars). */
function listUnder(key: string): string[] {
  const lines = yaml.split("\n");
  const i = lines.findIndex((l) => l.trim() === `${key}:`);
  const indent = lines[i]!.search(/\S/);
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    const m = l.match(/^(\s*)- "(.*)"$/);
    if (!m || m[1]!.length <= indent) break;
    out.push(m[2]!);
  }
  return out;
}

test("docs/slack-app-manifest.yaml scopes and events equal slack/manifest.ts", () => {
  expect(listUnder("bot")).toEqual([...SLACK_BOT_SCOPES]);
  expect(listUnder("user")).toEqual([...SLACK_USER_SCOPES_SIGNIN]);
  expect(listUnder("bot_events")).toEqual([...SLACK_BOT_EVENTS]);
});

test("docs/slack-app-manifest.yaml slash commands equal slack/manifest.ts", () => {
  const cmds = [...yaml.matchAll(/^\s+command: "(.*)"$/gm)].map((m) => m[1]);
  expect(cmds).toEqual(SLACK_SLASH_COMMANDS.map((c) => c.command));
});
