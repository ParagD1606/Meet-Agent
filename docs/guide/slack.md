# Slack: commands, manifest, huddles

## Slash commands
All nine are in `docs/slack-app-manifest.yaml` and `server/src/slack/manifest.ts`. Replies are private (ephemeral).

| Command | Usage | Who | Does |
|---|---|---|---|
| `/remember` | `/remember <fact>` | anyone | Saves a fact to memory in the scope of where you typed it |
| `/forget` | `/forget <what>` | anyone (admins wider) | Finds matching memories you may delete, then confirms |
| `/whatdoyouknow` | `/whatdoyouknow [@person or topic]` | anyone | Shows what is remembered that you can read |
| `/brain-review` | `/brain-review` | admins | Pending memory changes to approve or reject |
| `/brain-new` | `/brain-new` (or DM exactly `new chat`, `/new`, `reset`, `start over`) | anyone | Fresh chat: drops this conversation's chat history only. Memories, tasks, notes and open asks are kept. A DM idle longer than `dm_idle_reset_hours` (admin setting, default 6, 0 = off, max 72; `GET/PUT /api/settings/conversation {dmIdleResetHours}`) starts fresh on its own. Needs the manifest paste and reinstall below. |
| `/brain-pause` | `/brain-pause` | admins, channel creator | Stop learning from this channel, see [ambient-capture](ambient-capture.md) |
| `/brain-resume` | `/brain-resume` | admins, channel creator | Resume learning |
| `/brain-tasks` | `/brain-tasks` | anyone | Your open tasks and ones you assigned, see [tasks](tasks.md) |
| `/brain-followups` | `/brain-followups [list \| cancel <id> \| digest on 09:00 \| digest off \| weekly on\|off]` | anyone | Follow-ups and digest DMs |

## Manifest changes need paste and reinstall
Adding a command, scope or event is not picked up by redeploying the server. Copy `docs/slack-app-manifest.yaml` (or Setup > manifest) into Slack API > Your Apps > Company Brain > App Manifest, save, then **Install App > Reinstall to Workspace** when Slack asks. Until then Slack answers "command not found" or `missing_scope`. See [setup](setup.md).

## Huddle notes and canvases
`canvases.getContent` (scope `canvases:read`, markdown) works for Huddle notes canvases; see [`../spikes/huddles-canvases.md`](../spikes/huddles-canvases.md).

Import flow (`server/src/meetings/index.ts`, `server/src/slack/events.ts`):
1. **Events**: `file_created`, `file_shared`, `file_change`, and channel messages that attach a huddle canvas, trigger `ingestHuddleFile`.
2. Content is read from inline transcript lines, else `canvases.getContent`, else the linked transcript file, else a download with the bot token (Slack hosts only).
3. The bot must be a member of the channel; otherwise `huddle skipped: bot is not in the channel` is logged.
4. The text is analysed into meeting notes, decisions, tasks and open questions (Meeting notes page, memory episode and decision facts, tasks), then each person with a task gets ONE recap DM: see [manager](manager.md#meeting-recap-dms) and [tasks](tasks.md#meeting-tasks-what-happens-when-a-meeting-ends). The huddle starter is the organizer and assigner; the huddle participant list gives the model the people and their Slack ids.
5. **Manual Sync**: admins press Sync on Meeting notes (`POST /api/meetings/sync`, `?force=1` re-imports). It walks `files.list`, up to 20 imports per call; single flight. It also runs in Learn now > sync.
6. **Backfill**: Sync picks up past huddles the events missed (up to 50 pages of files).

Needs `canvases:read` and `files:read`; a `missing_scope` error names the scope to add, then reinstall.

Recap DM buttons use the existing interactivity endpoint (action ids `meeting_task_ack`, `meeting_task_done`, `meeting_task_decline`, `meeting_item_approve`, `meeting_item_reject`, `meeting_item_owner`, link buttons `meeting_link`). No new scopes: `chat:write` and `im:write` are enough. Extension and web uploads never send DMs by themselves.
