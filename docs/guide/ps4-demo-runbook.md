# PS-4 demo runbook: transcript to Trello in 3 minutes

Goal for the room: show that a messy meeting turns into the right tasks with owners and due dates, that a human approves anything doubtful, and that the approved work lands on a board and stays tracked. Evaluation criteria this maps to: extraction accuracy, commitment vs suggestion, duplicate/conflict detection, approval reliability, tracking and integration, usability.

> **Status of the pieces.** Steps marked **[web]** use the console Meetings page and **[export]** the Trello/GitHub push. Both ship with the meeting-UI and task-export work that was in progress when this was written; the labels below follow that build, so do one full dry run on the exact build you will present. Steps marked **[today]** exist in the deployed tree. Anything not yet merged has a fallback in the table at the end.

## Before you go on stage

Do this the day before, and again 30 minutes before.

1. **Environment** (`.env`, see `.env.example`): `ENCRYPTION_KEY` (32 bytes base64), `PUBLIC_URL` (https), `SLACK_APP_TOKEN` or `SLACK_SIGNING_SECRET`, model access (`MODEL_API_KEY`, or Vertex: `MODEL_PROVIDER=vertex`, `GOOGLE_VERTEX_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`), embeddings. `GET /readyz` must return 200 (database, queue and model).
2. **Sign in as owner/admin** in the console (only admins and the meeting's owner can approve). Open Meetings once so the page is warm.
3. **Demo workspace data**: seed the fictional company and the demo meetings.
   ```bash
   cd server
   bun run scripts/seed-demo.ts --yes            # people, channels, facts (needs the embedding provider)
   bun run scripts/seed-demo-meetings.ts --yes   # 3 processed meetings, 1 failed summary, 5 commitments (one overdue, one with no due date)
   ```
   Both are idempotent and refuse `NODE_ENV=production` without `--force`. Everything they write is marked `demo` / `demo:` / `seed-demo`.
4. **Trello [export]** (admin): at <https://trello.com/power-ups/admin> create a Power-Up, copy the API key, generate a token with read and write access. In the console: Integrations > Task boards > Trello: paste key and token, Save, pick the demo **board** and **list**, optionally map people to Trello members (cards are assigned only to mapped people), press **Test** (it only calls `GET /members/me`). Prepare an empty list called "Meeting actions".
5. **GitHub Issues [export]** (optional second target): fine-grained personal access token limited to one repository with **Issues: Read and write**; Integrations > Task boards > GitHub Issues: `owner/name`, token, labels, Save, **Test**.
6. **Slack**: the five demo people only get DMs if they exist in your workspace; for a stage demo use your own account as the owner (rename one transcript speaker or pick yourself in the owner picker) so you can show the DM.
7. **Files open in tabs**: `docs/demo/transcripts/messy.vtt` (and `messy.txt`), `docs/demo/expected-outputs.md`.
8. **Tests green** (2 minutes): `cd server && bun test test/meeting-eval test/meetings` (needs `DATABASE_URL` on a throwaway pgvector database, never the real one). Optional live accuracy proof: `bun --env-file=../.env run scripts/meeting-eval.ts` (about 90 seconds, a few cents).
9. **Clean slate before every run**: `bun run scripts/reset-demo.ts --yes` removes only demo-marked rows and prints counts; re-run the two seed commands afterwards. `--dry-run` shows what it would delete.

## The 3-minute script

Timing is a target, not a promise. Say the quoted line, do the click, point at the expected screen.

| Time | Do | Say | Expect on screen |
|---|---|---|---|
| 0:00 | Slide or no slide. | "Meetings end with a pile of 'I'll do that' and nobody knows who owns what. We turn a transcript into approved, tracked tasks, and we never guess." | Meetings page. |
| 0:15 | **[web]** Meetings > paste or drop `messy.vtt` (or click *Load messy sample*), set today's date, **Analyse**. **[today]** alternative: extension side panel > Import transcript > messy.vtt > Generate from whole transcript. | "A noisy, lowercase transcript with chit-chat. It reads the whole thing in one pass and every item has to carry a quote from the transcript." | "Analysing", then the result list within about 10 seconds. |
| 0:40 | Scroll the result groups. Click a quote's *line N*. | "Confirmed commitments, tentative ones, suggestions, open questions and decisions are kept apart. 'Maybe we should move the staging reset' is a suggestion, not a task. 'Who is going to renew the SSL cert' is an open question with no owner." | Badges confirmed / tentative / suggestion / question; transcript opens with the lines highlighted. |
| 1:05 | Point at the amber banners. | "It flags the Harbor invoice sample said twice as a duplicate, and the Kessler order form promised for Friday then Monday as a deadline conflict. The beta announcement has no owner, so it says *Needs owner* instead of guessing." | "Looks like / Merged with", "Heads-up: conflicts with", "Needs owner". Ticks 5, 6 and 7 of `expected-outputs.md`. |
| 1:35 | Resolve: open the conflict > *Resolve*, set Monday; on *Needs owner* pick a suggested person; reject the tentative on-call item or leave it for review. | "A human decides the doubtful ones. Approval is required for anything with a missing owner, a duplicate or a conflict; confident items can auto-assign if the admin leaves auto mode on, and there is a switch to require approval for everything." | Item cards update; *Approve* is disabled until an owner exists. |
| 2:00 | **Approve** the Tom invoice-bug item (or *Approve all needing review that have owners*). Open Tasks. | "Nothing is created or sent until it is approved. Now it is a task with an owner and a due date, the owner gets a DM with Done/Drop buttons, and it is written to team memory." | Item shows *Approved*, a task link and DM status; Tasks tab shows the row with owner and due date. |
| 2:20 | **[export]** On the meeting: Push > Trello. | "Approved tasks go to the project board with owner and due date; each task is sent once, so pressing it again cannot create a duplicate." | Toast with card links; open the Trello list: cards with title, `Owner:`, due date, the transcript quote and a source link. |
| 2:45 | Tasks tab > Overdue / unassigned chips. Close with the eval slide or `docs/qa/meeting-eval.md`. | "Then it tracks them: overdue and unassigned are highlighted, owners are chased, standups and risk scans use the same data. We measure this on 12 gold meetings: numbers in the repo." | Overdue row from the seed; chips. |

If you have only 90 seconds: skip 1:35-2:00 detail (approve one item) and do the Trello push.

## Fallbacks

| If this fails | Do this |
|---|---|
| Model slow or erroring during analysis | Open the pre-seeded meeting "Weekly sync (messy transcript)" (`seed-demo-meetings.ts`); it already has proposed, approved, rejected, duplicate and conflict items. Say it is a stored result of the same pipeline. |
| The seeded "failed summary" meeting is useful too | It shows a *Failed* meeting with a reason and *Retry* instead of a silent empty result. |
| Trello down, wrong token, rate limited | Use the **Export** menu: CSV (opens in Excel; formula-looking cells are neutralised), Markdown, JSON, or `.ics` for calendars. Say "same data, different sink". If the export UI is not merged yet, show the Tasks tab and the extension's per-item Approve/Edit flow. |
| Slack DM does not arrive | Say DMs are rate-limited and only go to resolved users; show the notification state on the item (pending/sent/failed) and the Tasks tab, which is the source of truth. |
| Web upload not in this build | Use the extension: side panel > Import transcript (`.txt/.vtt/.srt`), or run the `messy.txt` lines through the live panel. |
| Projector or network dies | Walk through `docs/demo/expected-outputs.md` and `docs/qa/meeting-eval.md` (numbers and confusion matrix). |
| Anything weird in the data | `bun run scripts/reset-demo.ts --yes`, then both seed scripts. Takes under a minute. |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Analysis stays "Analysing" | Model or queue unreachable: `GET /readyz`; check model credentials and quota. The meeting turns *Failed* with a reason and can be retried. |
| Items missing owners everywhere | The speaker names do not match workspace users. Seed the demo users (`seed-demo.ts`) or pick owners manually in the picker. |
| Seed script exits with "Refusing to run" | Add `--yes`; add `--force` only if `NODE_ENV=production` is really what you intend. |
| `reset-demo.ts` removed nothing | Nothing demo-marked was present (the printed counts say so); it never touches real rows. |
| Trello Test says 401 | Token lacks write access or was revoked; regenerate with read+write. 404: wrong board/list id. |
| GitHub Test says 404 | Token not scoped to the repository, or `owner/name` typo. |
| Eval prints "n/a" for duplicates, conflicts, grounding, approval safety | The pipeline build under test does not emit those fields yet (see `docs/qa/meeting-eval.md`); not a failure. |
| `bun test` complains about the database | Point `DATABASE_URL` at a disposable pgvector database (tests truncate tables). |

## Q&A for judges

**How do you stop hallucinated tasks?** Every task and decision must carry a quote copied from the transcript, checked in code (`server/src/meetings/verify.ts`, `quoteSupported`): items whose quote is not in the text are dropped (today) or kept only as "unverified" and never become tasks by themselves (unified pass). Owners must be people named in the transcript or the participant list.

**What about commitments versus suggestions?** Each item gets one of four labels (confirmed, tentative, suggestion, question) with a one-line reason. "I'll send it" is a commitment; "maybe we should" is a suggestion; "who is going to..." is an open question. On our gold meetings the live analyzer gets the label right for most matched items (see the confusion matrix in `docs/qa/meeting-eval.md`); the weak spot is hedged commitments read as firm ones.

**What if the owner or date is missing or ambiguous?** It stays empty and is flagged. We never infer an owner from who spoke or a date from "soon". Relative dates ("next Friday") are resolved against the meeting date, and unresolved phrases are kept as text.

**How do you detect duplicates and conflicts?** Within the meeting and against open tasks and recent meetings: title key, token overlap, embedding similarity, and a small model check only when unsure. Same task with different owners or dates is a conflict, never silently merged. These checks land with the pipeline unification; until then the extractor itself merges obvious restatements.

**Is a human in the loop?** Yes. Approval is the gate between extraction and anything visible to other people (tasks, DMs, board cards). Admins can choose automatic assignment above a confidence threshold, but never for items with a missing owner, a duplicate or a conflict. Today no DM leaves the system without an explicit "send".

**What did you evaluate on, and how well does it do?** Twelve hand-labelled meetings in the style of AMI and QMSum (we do not ship the corpora; loaders read a local copy), with planted relative dates, implicit owners, suggestions, questions, duplicates, conflicts and negatives. The real numbers, the confusion matrix and the limits are in `docs/qa/meeting-eval.md`. It is a small gold set: treat it as a regression gate, not a benchmark claim.

**Privacy?** Scopes follow the source: public channel notes are shared, private channels and extension uploads stay with their members or uploader, DM huddles are never listed to admins. Bot and OAuth tokens are encrypted at rest (AES-256-GCM), API tokens stored hashed, the board tokens encrypted. Self-hosted; the model call is the only data that leaves, to the provider you configure.

**What if the same meeting is uploaded twice or a push is repeated?** Uploads are idempotent per source id (the extension's externalId replaces the earlier record), commitments are idempotent on `source_ref`, and each task is pushed to a board once (a repeat returns the existing link).

**How does it keep going after the meeting?** Approved tasks are Tasks-tab rows and memory facts: overdue and unassigned highlighted, owners nudged (at most 3 per task, 3 DMs a day each), standups and risk scans from the same data, and "what did we decide last time?" answered from memory.

**What is not done?** Calendar/availability awareness, Jira write-back (only the read-only sync exists), speech-to-text (we consume transcripts and captions, not audio), and a larger evaluation set.
