# Grounding: how Pixel decides to answer or abstain

Rule: refuse or ask, never guess. Everything here is deterministic (no extra model call on the reply path) and runs in a few milliseconds.

Flow: question -> query rewrite -> recall -> **confidence signal** -> abstain policy -> answer -> **answer guards** (tautology, links, write claims) -> receipts -> post.

## The retrieval-confidence signal
Computed in `memory/recall.ts` from the ranked recall list (`memory/signal.ts`), returned as `Recall.signal` and stored in `recall_log.abstain_signal`.

| Signal | Meaning | What Pixel is told |
|---|---|---|
| `strong` | Recalled facts match the question by keyword or entity, with a clear top hit (or a very close semantic match), and every name in the question appears in a recalled fact or entity alias | Nothing extra |
| `weak` | Some support but thin (low rank, middling similarity), or only part of the named things are known ("Dana" known, "Zebra" not) | `<grounding>` "Evidence is thin: say what you found, label uncertainty, do not extrapolate." |
| `none` | No hits, or the question names something no recalled fact or alias mentions (the Berlin case), or hits share no keywords/entities with it and have low similarity | `<grounding>` "Memory has nothing relevant. Say plainly that you don't have it, say what you did check, and offer next steps..." |

Features: best raw rank (RRF x recency x importance, before any rerank), top-to-median gap, hits above the rank floor, packed hit count, keyword (AND query / name trigram) match, content words shared with a hit (2+ counts as support), max cosine, and named things in the question (capitalised names and ids; acronyms, dates and tool names are ignored) versus those found in hit text or entity aliases (typo tolerant, one letter).

Thresholds are exported constants in `memory/signal.ts` (`COS_NONE` 0.66, `COS_STRONG` 0.74, `TOP_STRONG` 0.3, `GAP_STRONG` 1.5, `SHARED_MIN` 2). Calibration on `test/memory-eval/cases.ts` (95 cases, with the fake embedder and with real `gemini-embedding-001` via `test/memory-eval/real-calibrate.test.ts`): precision of `none` on abstention cases 1.00, abstention recall 0.955 (the one miss is a partly-known name, deliberately `weak`), 0 answerable cases abstained. Real cosines of unrelated facts overlap answerable ones (0.48-0.80), so the entity and keyword features carry the decision, not cosine alone.

## Abstain policy
- The `<grounding>` block goes into the dynamic context (never the cached system prompt) only when the message is a factual question about company knowledge (`isFactualQuestion` in `turn/depth.ts`): not greetings, small talk, requests, task actions, saves, corrections, or messages with links or files.
- If a `<recent-channel>` block was supplied, `none` is softened to `weak` (the signal never saw that text).
- Memory-depth answers are held until the guards ran (no native streaming), so a stripped link or replaced reply is never shown first.
- **Escalate-on-abstain**: a memory-depth turn with signal `none` whose reply abstains, for a question that mentions a connected app or a web/Slack-ish topic, is retried once at tools depth before answering. One hop at most; recorded in `answer_checks.escalated` and the log line `grounding: memory abstained, escalating once to tools depth`.

## Answer guards (`turn/verify-answer.ts`)
1. **Tautology**: a factual answer whose claim sentences all share more than 80% of their content words with the question and are not backed by any recalled hit, tool result or the asker's own thread messages is replaced with an honest "I don't have a record that answers that" (`tautology_blocked`).
2. **Citations**: every http(s) link in the reply must appear in what the model was given this turn (recalled hits and permalinks, the asker's text, the thread, tool results, the system prompt). Others are stripped, their label text kept; `<url|label>`, `<url>`, `[label](url)` and bare URLs are handled (`stripped_links`).
3. **Write claims and receipts**: "I've told Dana" / "Dana has been notified" must be backed by a successful write tool result for that person. Otherwise Pixel gets one repair nudge, then the reply becomes "I didn't actually do that" (`receipt_mismatch`). `assign_task`, `update_task`, `notify_teammate`, `memory_remember`, `schedule_follow_up` end their result with `[receipt] <key> | <display>`; the reply gets `— receipt: <display>` (id, assignee, due, link) unless it already names the id or person. MCP writes get a generic receipt from the first URL or id in their result.

## Flags
Rows in the `settings` table, default on, effective within about 10 seconds. Switch one off with `insert into settings (key, value) values ('grounding_signal', 'false') on conflict (key) do update set value = excluded.value` (value `false`, `"off"` or `"0"`); delete the row to turn it back on:

| Key | Controls |
|---|---|
| `grounding_signal` | `<grounding>` instructions, escalate-on-abstain, tautology guard |
| `grounding_citations` | link allowlist stripping |
| `grounding_receipts` | target-matching claim guard and receipt lines |

With all three off, replies behave as before this change (the signal and `recall_log` diagnostics are still recorded).

## Reading `answer_checks`
One row per non-direct turn: `turn_id` (joins `turns`), `signal` (strong/weak/none), `abstained` (the none-policy was in force or the answer was replaced), `stripped_links`, `tautology_blocked`, `receipt_mismatch`, `escalated`.
- Hallucinated links per day: `select date(at), sum(stripped_links) from answer_checks group by 1`.
- How often Pixel abstains: `select signal, count(*) from answer_checks group by 1`.
- A bad answer: find its turn id, then `recall_log` by channel/thread for `ranks`, `scores` (RRF score and cosine of the top candidates), `rewritten_query`, `abstain_signal`, `pack_tokens` and `depth`.
- A wrongly abstained question shows `signal = none` with a non-empty `hit_ids` or a high `scores[].sim`: look at `rewritten_query` and at which name in the question no fact mentions.
