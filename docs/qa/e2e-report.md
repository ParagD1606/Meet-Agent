# Live e2e report (real Vertex Gemini + embeddings, throwaway Postgres, fake Slack)

Base: main working tree at HEAD d0dc08a plus later main changes (re-synced to 13318df before the final run).
Models: `gemini-3.5-flash` (main role), `gemini-3.5-flash-lite` (extract / triage / summarize), `gemini-embedding-001` at 1536 dims.
Scenarios: `server/scripts/e2e/NN-*.ts` (run with `bun`, never in CI; need `MODEL_PROVIDER=vertex`, ADC, and a `DATABASE_URL` containing `5433`).
Harness: `server/scripts/e2e/harness.ts` (fake Slack client with permalinks, real `handleEventCallback`, real turns, LLM judge, counts model traffic).
Regression tests for every fix: `server/test/qa/e2e-fixes.test.ts`, `server/test/api/consolidation-undo.test.ts`, `server/test/memory/bootstrap.test.ts`, `server/test/meetings/title.test.ts`.

## Answer-quality numbers (scenario 03, 43 questions incl. 3 thread follow-ups, LLM judge)

| Category | Correct |
|---|---|
| direct facts | 12/12 |
| facts from extra ambient chat | 5/5 |
| temporal (current value, "as of September", "back in March/August") | 5/5 |
| multi-hop via entities | 4/5 |
| private-channel facts asked inside the channel | 2/2 |
| private facts asked from outside (must not reveal) | 2/2 |
| abstention (CTO, Q4 revenue, Berlin office, Wi-Fi password, Series A, phone) | 5/6 |
| thread follow-ups ("and when is it deployed?") | 3/3 (+3/3 second turns) |
| total | 41/43 (95%) |

Latency (memory-depth turn, 4 in parallel): avg 4.7 s, p max 10.8 s. Estimated prompt tokens avg 2475, max 3353.
Turn ledger: memory depth avg 4674 in / 60 out, 2.0 steps, 2517 micro-USD per turn.

Recall layer, MEMORY_RERANK off vs on (32 questions with a key-fact pattern): both 30/32 (misses: #20 regex artifact, #26 seed data below).
Rerank ON: 66.4 s vs 6.2 s for the same 32 recalls (10.7x, one extra model call each), and it packs fewer tokens (avg 89 vs 212), with no recall gain. Recommendation: leave it off.

Misses:
- #26 "What feature flag does Project Lantern ship behind?": the fact lives under `channel_CDEMO_ENG` in `seed-demo.ts`, but CDEMO_ENG is a PUBLIC channel, so `readTags` correctly never reads that tag there. Seed data bug (the channel-tagged ENG/CS facts should be private channels, or tagged `shared`). Not a product bug.
- #34 "Which city is our Berlin office in?" answered "Our Berlin office is located in Berlin." Hallucinated tautology instead of abstaining (1 of 6 abstention questions).

## Per-feature results

See the table in the final hand-off message; per-run evidence is printed by each script (PASS/FAIL lines with the data).

## Bugs found and fixed

1. Bootstrap "About" line ignored every ambient fact (04). `memory/bootstrap.ts:77` matched `source_ref = <channel>`, ambient facts use `<channel>/<first ts>`. Public-channel About was built from the Slack purpose only.
2. Weekly digest and deadline reminders never saw ambient facts (06). Same root cause in `automations/proactive.ts` `channelFacts` (and the weekly status attribution in `manager/standup.ts`, see "not fixed here").
3. `/remember` and `memory_remember` stored credentials (07): `/remember the prod password is hunter2-secret-9` was saved workspace-wide. `memory/facts.ts` `rememberFact` now applies `hasSecret`.
4. MCP tools with an argument named `title` / `examples` / `$id` broke every turn on Gemini (09): `mcp/tools.ts` `minSchema` dropped the property from `properties` while `required` still listed it, Vertex answered 400 "schema at top-level requires unspecified property 'title'", the user saw "Something went wrong". Linear/GitHub/Jira `create_issue` all have `title`.
5. Steering REPLACE never fired with Gemini (11): the classifier used `maxOutputTokens: 5`, "REPLACE" came back as "RE", no match, silently APPEND. Fixed in `turn/steering.ts` (and the same cap in `turn/depth.ts` classifier). Evidence: 8 of 8 probes returned APPEND/IGNORE only.
6. Nightly procedure extraction re-proposed reworded procedures every night (05): `memory/consolidate.ts` now waits while a procedure review is pending (run 2 created 2 more reviews before the fix).
7. `undoConsolidation` had no caller (05): added admin `GET /api/consolidation-log` and `POST /api/consolidation-log/:id/undo` (`routes/memory-ext.ts`). No UI yet.
8. Readable huddle titles missed the separate "Huddle transcript" file (12): `meetings/index.ts` `cleanTitle` only matched "Huddle notes".
9. Fact extractor was not told the weekday of "today" (02, `memory/writeback.ts`). The commitment extractor has the same gap, see below.

## Findings in files owned by other agents (NOT edited; proposed changes)

- `turn/loop.ts`: Gemini 3.x spends hidden reasoning against `maxOutputTokens`. Probe (default effort, one-line lookup): 576 output tokens of which 527 reasoning; with `thinkingLevel: "minimal"` 45 tokens. Memory-depth cap is 800, so answers were cut mid-link ("Source: &lt;https://"). Ledger evidence (scenario 13): 1873 of 2096 output tokens (89%) were reasoning on memory-depth turns. Proposed fix, verified live (answers complete, 40% cheaper): in `runOnce` pass `providerOptions: { vertex: { thinkingConfig: { thinkingLevel } }, google: {...} }` with `minimal` for memory, `low` for tools, default for deep, only when the model id starts with `gemini-3`.
- Step cap: `prepareStep` sets `stopped = "step_cap"` whenever the last allowed step is reached, even when the wrap-up step produced a complete answer. Every abstention and several correct answers ended with "I ran out of working room on this one" (about 1 in 3 memory-depth answers in scenario 03). Worse, ask_teammate flows were cut off: the model said "I was about to reach out to Dana but ran out of space to initiate the handoff" (3 of 3 attempts when the model searched first). The memory depth cap is 4 steps; the model burns 2-3 on `memory_search` after `find_tasks` already matched.
- `manager/find.ts` `formatTasks`: owner printed as `<@U123>` only, so the model says "I couldn't resolve the plain name for <@U..>". Proposed: `owner: <@U123> (Priya Sharma)` (keeps the existing `owner: <@U` substring tests).
- `manager/commitments.ts` extractor prompt: give `Today: Saturday 2026-10-24` (weekday) and the rule "a bare weekday is the next such day". `by Friday` said on a Saturday returned the previous Friday.
- `manager/standup.ts` `buildWeeklyStatus` attribution has the same `source_ref` bug as bootstrap/digest: add `or source_ref like '<channel>/%'`.
- `prompt.ts` memory section: "answer straight from a matching find_tasks row, no extra memory_search" cut tool steps from 4 to 2 for task lookups.
- `follow-up-tool`: the model rewrites the text ("Hi Dana, Alice wanted to follow up..."), then the DM wraps it again ("<@Alice> asked me to follow up with you: "Hi Dana, ...""). Double greeting.

## Other answer-quality observations

- Ambient facts from one batch all share the permalink of the batch's FIRST message (6 pricing/launch facts linked to the same message). "Source:" links are right for the first fact only.
- A forced wrap-up turn that is an abstention suggests tools that do not exist ("connect Jira or Asana") for an internal question.
- The broadcast refusal still drafted announcement text with an invented detail ("work remotely").
- Background LLM work (extraction, rewrite, rerank, consolidation, bootstrap) is not in the cost ledger; only turn calls are. In scenario 13, 12 chat calls were made for 5 turns, 5 of them outside the ledger.
- Deep-depth turns are slow: 38-40 s each for a 7-fact summary (scenario 11), two such turns = 80 s.
- Lantern beta example: after "moved from October 14 to October 21" the answer was correct (October 21), supersede worked.

## Not covered / limits

- Slack sockets, real signature timing beyond the replay window, pg-boss schedules (jobs run directly), the browser extension.
- Connectors ran against fake HTTP payloads shaped like the real APIs.
- Quiet hours are OFF by default in main; scenarios 06 and 08 exercise the `QUIET_HOURS=1` opt-in.

## Final run per feature (all scenarios re-run on the final tree)

| # | Feature | Result |
|---|---|---|
| 1 | ambient capture | 28/29 (1 LLM-variance FAIL, below) |
| 2 | task capture + find_tasks (real runTurn) | 24/24 (assign_task block behind E2E_ASSIGN=1, owned by tasks agent) |
| 3 | recall quality (40+3 questions) | 41/43, see numbers above |
| 4 | core-block bootstrap | 16/16 (after fix 1) |
| 5 | consolidation v2, undo, soft delete, reviews | 30/30 (after fixes 6, 7) |
| 6 | manager (chase, standup, risks, digest, deadlines) | 32/32 (after fix 2) |
| 7 | slash commands + forged payloads | 38/38 (after fix 3) |
| 8 | follow-up / ask_teammate / Resolve | 21/22 (ask card not produced when the model hits the step cap, other agent's lane) |
| 9 | approval classes + untrusted context | 13/13 (after fix 4) |
| 10 | persona + refusals | 14/14 |
| 11 | steering + idempotent posting | 8/9 (REPLACE now works; the FAIL is a strict regex on the merged answer) |
| 12 | connectors + huddle | 29/29 (after fix 8) |
| 13 | cost ledger + spend alert | 12/12 (ledger input/output tokens equal Vertex usageMetadata exactly, ratio 1.000) |
| 14 | freshness + run-now | 14/14 (fast ambient latency 19.5 s, normal mode silent for 20 s, 4 concurrent runs -> 1x200 + 3x409) |

Open item in 01: a literally repeated message (new ts) is re-extracted; when the model words the fact differently (cosine < 0.97) the old fact is superseded by its own paraphrase, adding a "supersede" review per repeat. Replayed events and same-ts redeliveries are correctly deduped.
