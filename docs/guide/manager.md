# Pixel as manager

Code lives in `server/src/manager/`. Everything respects the scope model (`memory/scope.ts`): a public channel only ever sees `shared` data, a private channel adds its own tag, DM-scope items are never posted.

## Commitments

Table `commitments`: owner, text, due date, source (fact / meeting / message / ticket, with permalink), channel + thread, `scope_tag`, status (`open`, `done`, `dropped`, `overdue`), `last_nudged_at`.

Hourly job `manager-extract` picks up what was captured since its cursor (`settings.manager_extract_cursor`): decision/procedure facts and thread episode summaries go through the cheap-model extractor (`extractFromText`, only when the text has a promise cue), meeting tasks are copied directly. Rows are idempotent on `source_ref`. `extractFromText` is exported if you want to call it from a writeback hook.

## Chasing

Hourly job `manager-chase` marks overdue items and nudges owners when a commitment is due within 24h, then at the first overdue tick, then at most daily, 3 nudges total. The nudge @mentions the owner in the original thread when they are a channel member, otherwise DMs them, with Done / Drop buttons (only the owner or an admin can press them).

Limits: per-person bucket `chase` in `limits/rate.ts` (3 burst, 3/day). Quiet hours: nothing is sent outside the working window, default 09-18 Mon-Fri. Timezone comes from `settings.timezone` (IANA, default UTC); override the window with `settings.manager_hours = {"start":9,"end":18}`.

Not wired yet: replying "done" or reacting with a checkmark (needs hooks in `slack/events.ts`; the close logic is `resolveCommitment`).

## Standups and risks

Opt in per channel with the proactive-features setting (`PUT /api/settings/proactive-features`, keys `standup` and `risks`).

- `standup`: weekday 09:05 per-person daily summary (done / in progress / blocked) and Friday 16:00 weekly project status (commitments, decisions, GitHub/Linear facts, threads, meetings).
- `risks`: weekday 09:30 scan: slipping commitments, sources that disagree (pending reviews, cross-source supersessions), stale decisions (old decision with newer related facts), duplicated work (near-identical commitments with different owners). Shared-scope risks go to the originating public opted-in channel, else the admin home channel; private-scope risks go only to their own opted-in private channel. Each risk key is posted once (`manager_risks`).

## API

`GET /api/manager/commitments?status=open,overdue&owner=U123&limit=100` (admin). Results are filtered to the requester's own read surface (shared + their private channels + their DM tag).
