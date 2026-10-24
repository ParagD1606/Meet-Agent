# Tasks

Tasks (internally commitments) live in three agreeing places: the Tasks tab, a memory fact (`Task "X" [open]: assigned to ...`) and Slack notifications. Every status or owner change rewrites the fact and supersedes the old one. Code: `server/src/manager/*`, `server/src/turn/task-tools.ts`.

## Where they come from
- Asking Pixel: "assign the launch to @Parag, urgent, by Friday".
- Ambient capture of commitment-like messages, and thread replies that finish them.
- Meeting notes (huddles, extension, uploads): confident action items with a clear owner become tasks by themselves, see "Meeting tasks" below.
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

## Exceptions: unassigned, no due date, overdue
Flags are computed (nothing is stored): `overdue`, `unassigned`, `noDue`, `dueSoon` (due within 3 days), `stale` (still `open`, older than 14 days, not nudged for 14 days) and `urgent`. `GET /api/tasks` returns them on every task plus `counts` ({total, open, overdue, unassigned, noDue, dueSoon, done7d}) over everything the caller may read, and accepts `unassigned=1`, `noDue=1`, `stale=1`, `dueSoon=1` next to `overdue=1`. The Tasks tab shows the counts as clickable chips, a "Needs attention" tab (overdue, unassigned or no date), flag badges with inline Assign / Set date, and lists those tasks first.
- `/brain-tasks` and the daily digest group tasks as Overdue, Unassigned (you assigned, no owner), No due date, Due soon (a task appears once), with an `Overdue (n) | No due date (n) | Waiting on others (n)` summary and Done/Drop buttons.
- The daily standup and weekly status end with a "Needs attention" block (unassigned, no due date; weekly adds the oldest 5 overdue and stale). An owner is @mentioned only when they can read the channel's scope.
- The risk scan adds `unassigned_aging` (no owner for more than 3 days) and `no_due_date` (urgent, no date for more than 3 days), de-duplicated by key like other risks.
- Chasing: a task with an owner but no date is chased weekly (3 times at most) only when urgent or older than 14 days. A task with no owner is surfaced to its assigner only, every 3 days, 3 times at most. Both use the same per-person chase limit and quiet-hours setting.

## Meeting tasks (what happens when a meeting ends)
When the notes are generated everything happens without a click (default mode `auto`):
1. **Notes**: summary, decisions, tasks and open questions are saved on the Meeting notes page. Every item carries `kind` (commitment / suggestion / question), `label`, `confidence`, the quote and the transcript line numbers it came from. An item whose quote is not in the notes is kept but marked `unverified` and never becomes a task.
2. **Tasks**: an item with kind `commitment`, confidence at or above the workspace threshold (default 0.6, admin range 0.3-0.95), an owner who resolves to a real person and a verified quote is approved by `auto` and becomes a task (`sourceType: meeting`, `source_ref meeting:<meetingId>:<itemId>`). Assigner = whoever started the huddle / uploaded the call; due date resolved against the meeting date; "urgent / asap" makes it urgent; scope by the same fail-closed rule as everything else (public channel `shared`, private `channel_X`, extension / web upload `user_<uploader>`). The task also gets its memory fact; decisions become `decision` facts with the meeting link.
3. **Duplicates and conflicts**: a duplicate of an open task (same scope) or of an item in another meeting of the last 30 days is auto-merged (no second task, the item points at the existing one, `merged: true`); the same task with another owner or due date is created and flagged (`ambiguity.conflicts`); a date or owner that was changed inside the meeting keeps the earlier value as a `restated` conflict and the latest wins. "Undo merge" is `POST /api/meetings/:id/items/:itemId/dismiss-duplicate`.
4. **Needs a human**: below the threshold, suggestions, open questions, `unverified` items, and items with no resolvable owner stay `proposed` on the Meeting notes page. A missing or unclear owner is not a confidence problem: the organizer gets a "Who owns ...?" card with up to 3 candidates.
5. **Undo**: rejecting an auto-approved item drops its task (status `dropped`, audit note "undone by ...") and nobody is told again. "Make it a task" on a suggestion (`PATCH kind: commitment`) marks it tentative and then the normal rules apply.
6. **Re-analysis** (notes edited, manual Sync with force, canvas finished late) matches items by id / title: the same tasks are updated, never duplicated; owners who were already told are not told again; new items are created and announced; a task that is no longer in the notes is dropped only if nobody acknowledged it and it is still open. Owner decisions stick (a "Not mine" stays unassigned).
7. **Backfill** (`sync-tasks`): old meetings get tasks without any DM or organizer card; an admin can press "Send recap now" (`POST /api/meetings/:id/recap`) per meeting.

Workspace switch: `GET/PUT /api/settings/meetings {mode: "auto" | "approve", autoConfidence}` (admin). In `approve` mode nothing is automatic: every item stays proposed (no task, no memory fact, no DM to owners) until approved; the organizer gets a DM with Approve / Reject buttons. Approval needs the organizer, the meeting owner or an admin; approving an item without a clear owner needs `assigneeId` in the request (409 `needs_owner`), an unverified item needs `confirm: true` (409 `needs_review`), an open question cannot be approved. Bulk (`POST /api/meetings/:id/approve {itemIds}` or `{all: "confirmed"}`) approves only confirmed, unambiguous, verified items and returns the rest as `skipped` with a reason. Every approve / reject / edit / merge writes a row to `meeting_audit` (`GET /api/meetings/:id/audit`), auto approvals are recorded with `approvedBy: "auto"`.

Meeting API (session auth): `GET /api/meetings`, `GET /api/meetings/:id` (items, counts, `mode`, `autoConfidence`, transcript `lines [{n, speaker, text}]` when the viewer may read them), `POST /api/meetings {title, text | lines, format?, startedAt?, channelId?}` (any member; txt / vtt / srt / json parsed server-side, 20k lines, 4k chars a line, 2 MB, secrets scrubbed; private to the uploader unless they belong to `channelId`), `POST /api/meetings/:id/reanalyze` and `/retry`, `PATCH /api/meetings/:id/items/:itemId {title?, description?, dueDate?, assigneeId?, priority?, kind?, approval?, confirm?}`, `POST .../items/:itemId/merge {intoId}`, `.../dismiss-duplicate`, `.../dismiss-conflict`, `POST /api/meetings/:id/recap {itemIds?}`. Uploads never DM anyone by themselves.
