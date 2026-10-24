# Tasks

Tasks (internally commitments) live in three agreeing places: the Tasks tab, a memory fact (`Task "X" [open]: assigned to ...`) and Slack notifications. Every status or owner change rewrites the fact and supersedes the old one. Code: `server/src/manager/*`, `server/src/turn/task-tools.ts`.

## Where they come from
- Asking Pixel: "assign the launch to @Parag, urgent, by Friday".
- Ambient capture of commitment-like messages, and thread replies that finish them.
- Meeting notes (huddles, extension): action items become tasks.
- `sync-tasks`: backfills tasks from existing memory facts that look like assignments and from meetings. Idempotent. Run it from Learn now (`POST /api/memory/run {job: "sync-tasks"}`); it also ran once automatically.

## Tools Pixel uses
| Tool | Does |
|---|---|
| `assign_task` | Creates a task, remembers it, and tells the assignee at once (thread mention if they are in the channel, else DM) with Done and Drop buttons. Titles that look unsafe are refused. |
| `update_task` | Done, dropped, open, in progress; reassign; change due date or priority. Only the owner, the assigner or an admin may. The assigner is told when it is done. |
| `notify_teammate` | Relays the asker's own words to a teammate. Links and mentions the asker did not write are refused. Limited per recipient per day. |
| `find_tasks` | Read-only lookup by text, owner, assigner, channel, status or due range, within what the asker may read. |

## Slack commands
- `/brain-tasks`: your open tasks and ones you assigned, with buttons.
- `/brain-followups`: `list`, `cancel <id>`, `digest on [HH:MM] [mon-fri|daily|mon,wed]`, `digest off`, `weekly on|off`. The daily digest is off by default and uses the workspace timezone.

## The Tasks tab
Views: All, Mine, Assigned by me, Overdue; list or by person; status filters Active, Open, In progress, Overdue, Done, Dropped. You can create and edit tasks there (`GET/POST /api/tasks`, `PATCH /api/tasks/:id`).

## Scopes
A task carries the scope of where it was made: public channel `shared`, private channel `channel_<id>`, DM `user_<id>`. Lists, digests, risks and tool lookups only return tasks the person can read; a task outside that is treated as not found. A task assigned in a DM stays visible to its owner.

## Chasing
Hourly (minute 41) Pixel nudges an owner when a task is due within 24 hours or overdue: first at that point, once more when it first goes overdue, then at most daily, 3 nudges per task in total. Each person gets at most 3 chase DMs per day. With `QUIET_HOURS=1` nudges wait for the workspace working window; assignment notices never wait. Daily standup (09:05 Mon-Fri), risk scan (09:30 Mon-Fri) and weekly status (Fri 16:00) run in the workspace timezone and are opt-in per channel on the Pixel page.
