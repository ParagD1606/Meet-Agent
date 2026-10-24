# Demo transcripts: what the system should extract

A checklist for the presenter. Every name below is a fictional person in the seeded demo workspace (`seed-demo.ts` users `UDEMO01..05`: Priya Raman, Marcus Lee, Sofia Alvarez, Tom Becker, Dana Okafor), so owners resolve to real users. Dates are relative to the day the meeting is uploaded; the examples assume it is **Tuesday 2026-06-09**.

Files in `docs/demo/transcripts/`:

| File | Use |
|---|---|
| `clean.txt` | 19 lines, "Name: text". The happy path: four clear commitments with owners and dates, one decision. |
| `messy.txt` | 59 lines of lowercase, disfluent speech with chit-chat and cross-talk. Contains every case below. |
| `messy.vtt`, `messy.srt` | The same conversation as WebVTT (`<v Name>` voice tags) and SubRip captions (`Name: text`), for the caption-file upload. |

## clean.txt

| # | Item | Type | Owner | Due (if uploaded 2026-06-09) |
|---|---|---|---|---|
| 1 | Reserve launches in November | decision | n/a | n/a |
| 2 | Set up the Stripe webhook alerts | task, confirmed | Marcus Lee | Fri 2026-06-12 |
| 3 | Send the invoice sample to Harbor Cafe | task, confirmed | Sofia Alvarez | Wed 2026-06-17 ("next Wednesday") |
| 4 | Prepare and share the billing migration plan | task, confirmed | Tom Becker | 2026-06-30 ("end of the month") |
| 5 | Draft the launch checklist and send it to the team | task, confirmed | Priya Raman | Mon 2026-06-15 |

Nothing in it is ambiguous, so with auto-approval on these go straight to tasks and DMs; with approval required they sit in "Proposed" until approved.

## messy.txt (also .vtt and .srt)

Seven things the demo has to show. Tick them as they appear on the review screen.

| # | What the audience should see | Where in the transcript | Expected result |
|---|---|---|---|
| 1 | **Confirmed commitment** | Tom: "i'll fix the duplicate invoice bug by thursday" | Task, `confirmed`, owner Tom Becker, due Thu 2026-06-11, with the quote |
| 2 | **Tentative commitment** | Dana: "i'll probably update the on-call doc at some point this week ... i might not get to it before friday" | Task, `tentative`, owner Dana Okafor, due left empty or "this week" (never invented), flagged for review, not auto-approved |
| 3 | **Suggestion, not a task** | Marcus: "maybe we should move the staging reset to saturday night", then Dana: "let's not decide that now" | `suggestion`; offered as "Make it a task", no owner, no DM |
| 4 | **Unresolved question** | "so who's going to renew the ssl cert" ... "ok so nobody" | Open question, no owner; never turned into someone's task |
| 5 | **Duplicate pair** | Sofia says she will send Harbor the invoice sample twice ("friday" both times; Dana: "sofia you said that already") | One task (merged) or two tasks with a "Looks like" duplicate flag; never two separate DMs |
| 6 | **Deadline conflict** | Priya: Kessler order form "by friday", later Tom: "the finance cut-off, it's monday not friday" and Priya: "i'll send the order form to kessler on monday" | A due-date conflict is flagged (Fri 2026-06-12 vs Mon 2026-06-15) for a human to resolve; it must not be silently overwritten |
| 7 | **Missing owner** | Sofia: "we still need the beta announcement to go out to harbor, somebody should write that"; Dana: "that needs doing"; nobody volunteers | Task with "Needs owner"; cannot be approved until someone is picked |

Also expected from `messy.txt`:

- Decision: "dark mode is after the beta" (Dana, "decided").
- Task: Marcus Lee reviews the checkout PR today (due Tue 2026-06-09), confirmed.
- No tasks from chit-chat (the game, "if we had more people we could do everything lol").
- Every item carries a quote that appears in the transcript.

## What the pipeline does today

Observed on 2026-10-24 by running the existing live analyzer (`analyzeLiveMeeting`, Vertex `gemini-3.5-flash`) over these files, before the pipeline unification lands:

- `clean.txt`: all four tasks and the decision found, correct owners and dates (the decision's date comes back as "2026-11").
- `messy.txt`: confirmed tasks 1 and the checkout review correct; the on-call doc is `tentative` with a vague due ("this week"); the staging reset comes back `tentative` rather than `suggestion`; the SSL question and the dark-mode decision are right; the unowned beta announcement is a task with no owner. The Harbor duplicate is merged into one task (item 5 satisfied by merging). The Kessler conflict (item 6) is **not flagged**: the later date (Monday) silently wins. A conflict flag and the explicit approval gate land with the pipeline unification; until then the presenter should point at the transcript quote and say the system keeps the latest statement.

Update this section after the unified pass lands and `bun run scripts/meeting-eval.ts` has been re-run.
