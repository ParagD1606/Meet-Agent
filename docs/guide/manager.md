# Pixel as manager

Code lives in `server/src/manager/`. Everything respects the scope model (`memory/scope.ts`): a public channel only ever sees `shared` data, a private channel adds its own tag, DM-scope items are never posted.

## Commitments

Table `commitments`: owner, text, due date, source (fact / meeting / message / ticket, with permalink), channel + thread, `scope_tag`, status (`open`, `done`, `dropped`, `overdue`), `last_nudged_at`.

Hourly job `manager-extract` picks up what was captured since its cursor (`settings.manager_extract_cursor`): decision/procedure facts and thread episode summaries go through the cheap-model extractor (`extractFromText`, only when the text has a promise cue), meeting tasks are copied directly. Rows are idempotent on `source_ref`. `extractFromText` is exported if you want to call it from a writeback hook.

## Chasing

Hourly job `manager-chase` marks overdue items and nudges owners when a commitment is due within 24h, then at the first overdue tick, then at most daily, 3 nudges total. The nudge @mentions the owner in the original thread when they are a channel member, otherwise DMs them, with Done / Drop buttons (only the owner or an admin can press them).

Limits: per-person bucket `chase` in `limits/rate.ts` (3 burst, 3/day). Quiet hours: nothing is sent outside the working window, default 09-18 Mon-Fri. Timezone comes from `settings.timezone` (IANA, default UTC); override the window with `settings.manager_hours = {"start":9,"end":18}`.

Replying "done" in the task thread closes it (see Real-time capture). Not wired: a checkmark reaction.

## Real-time capture, edits and history

- Every message in a channel the bot is in is cue-checked (`manager/capture.ts`); only task-sounding ones reach the cheap model. "@Priya please send the report by Friday" becomes a commitment at once: owner from the mention id, assigner = author, due date resolved against the message time, `permalink` of that exact message, scope by the same fail-closed channel rule (public -> shared, private -> channel_X), idempotent by (channel, ts) via `source_ref = msg:<channel>:<ts>:<i>`.
- Thread replies on a task ("I'll take this", "Dana took this instead", "done") reassign or close it (a cheap classifier runs only when a status cue matches; only the owner or assigner can close) and write a status-change fact in the same scope.
- `message_changed`: the still-active commitments from the old text are replaced by a re-extraction (same text = no-op); buffered text is updated; a fact batch that came from that single message is retired and re-extracted. `message_deleted`: its commitments become `dropped` and facts from that single message are deleted. Gaps: a fact distilled from several messages, or from the polling observe job, cannot be attributed to one message and stays; a re-extraction that fails after the old rows were removed loses the task until the next edit.
- History backfill (`memory/backfill.ts`): when the bot joins a channel (pg-boss `memory-backfill-history`), hourly as a safety net, or via `POST /api/memory/run {"job":"backfill-history"}`. Reads `conversations.history` and thread replies back `settings.memory_backfill_days` (default 30, max 90) through the same ambient buffering, paced at about 50 Slack calls a minute with Retry-After handling and a per-run call budget (`MEMORY_BACKFILL_CALLS_PER_RUN`, default 20). Progress is a cursor in `settings` (`backfill:<channel>`), so a run resumes where the budget stopped. Backfilled tasks that are already past due are listed but never chased.
- `find_tasks` (read-only; also at memory depth and on read-only turns) answers "who was given X / who owns Y / what is due" with owner, assigner, due, status and the message permalink, limited to what the asker can read.

## Follow-ups and digests (DMs)

- `schedule_follow_up` tool: "remind me Friday to check with Dana" DMs only the requester (no approval card). "Follow up with @Bob on the invoice" posts a consent card to the requester with the exact text; Bob is DMed only after the click. One-shot or every N days (1-90), at most 20 active per person, table `follow_ups`.
- Delivery (pg-boss `manager-followups`, every minute) happens only in working hours (workspace timezone), is charged to the recipient's `followup` bucket (5 burst, 20/day), and carries only the text the requester wrote.
- `/brain-tasks`: ephemeral list of tasks assigned to you and ones you assigned, with Done / Drop buttons (owner, assigner or admin). `/brain-followups`: list, `cancel <id>`, `digest on [HH:MM] [mon-fri|daily|mon,wed]` / `digest off` (daily task digest DM, default off), `weekly on|off` (Friday 16:00 summary). Prefs live in `settings` (`followprefs:<user>`). Digests only list tasks the recipient can read.

## Standups and risks

Opt in per channel with the proactive-features setting (`PUT /api/settings/proactive-features`, keys `standup` and `risks`).

- `standup`: weekday 09:05 per-person daily summary (done / in progress / blocked) and Friday 16:00 weekly project status (commitments, decisions, GitHub/Linear facts, threads, meetings).
- `risks`: weekday 09:30 scan: slipping commitments, sources that disagree (pending reviews, cross-source supersessions), stale decisions (old decision with newer related facts), duplicated work (near-identical commitments with different owners). Shared-scope risks go to the originating public opted-in channel, else the admin home channel; private-scope risks go only to their own opted-in private channel. Each risk key is posted once (`manager_risks`).

## API

`GET /api/manager/commitments?status=open,overdue&owner=U123&limit=100` (admin). Results are filtered to the requester's own read surface (shared + their private channels + their DM tag).

## Tasks (console tab, Pixel tools)

Every task is a commitment row, a memory fact (`Task "X" [open, urgent]: assigned to ...`, superseded on every status change) and, in the console, a row in the **Tasks** tab (all members; `/commitments` redirects there).

- Pixel tools: `assign_task` (creates the task, tells the assignee at once in-thread or by DM with Done/Drop, no quiet hours), `update_task` (done/open/dropped/in_progress, reassign, due, priority; owner, assigner or admin; the assigner is told "X completed"), `find_tasks` (answers "is X done?" from status), `notify_teammate` (relay the asker's own words; 5/day per target; consent card when outside text entered the turn).
- API (any member, scope-filtered like the commitments listing; a DM-scoped task is also visible to the person it was explicitly assigned to): `GET /api/tasks?status=&owner=&assigner=&q=&channel=&mine=1&assignedByMe=1&overdue=1&dueAfter=&dueBefore=`, `PATCH /api/tasks/:id {status?, ownerId?, due?, priority?}`, `POST /api/tasks {title, ownerId, due?, priority?, channelId?}`, `GET /api/people`.
- `POST /api/memory/run {job:"sync-tasks"}` (admin) and a one-time boot backfill turn existing assignment facts and meeting tasks into tasks. Idempotent: tasks dedupe by owner + normalized title + channel.
