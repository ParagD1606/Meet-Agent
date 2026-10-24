# Evaluation baseline (first real run)

Run: 2026-10-24, local, `server/scripts/eval-nightly.ts` against a throwaway Postgres, real Vertex. Answer model `gemini-3.5-flash`, judge and extraction/rewrite `gemini-3.5-flash-lite` (the judge always differs from the answerer), embeddings `gemini-embedding-001` at 1536 dims, minimal thinking on every call. Cost $0.32 of a $2 budget, 1438 s, 2293 LLM calls. Report: `server/test/eval/last-nightly.json`. All 8 sets ran; no phase or item errored. The exit code was 1 because the thresholds below were breached: this is the starting point, not a pass.

Method notes: the answer step is a tool-less memory turn (real system prompt + recalled memory), not the full replay harness. Abstention uses its own corpus because an old memory-eval seed mentions a Berlin office. Earlier smoke and aborted runs (a 429 and a full `/tmp`) cost about $0.29 more and are not part of these numbers.

## Headline against the alert thresholds
| Metric | Value | Threshold | Status |
|---|---|---|---|
| unsupported_claim_rate (claim-level, 211 claims) | 0.028 | <= 0.02 | FAIL |
| citation_validity | 1.0 | 1.0 | ok |
| trap abstention (tautology traps) | 6/8 | >= 5/6 | FAIL |
| abstention recall, all 30 | 0.633 | n/a | see below |
| false-abstain rate (qa, multihop, temporal) | 0.017 | n/a | ok |
| secrets stored through the ambient path | 1 | 0 | FAIL |
| empty model answers (first try / after one retry) | 11.3% / 10% | n/a | defect, see below |

## The two standing questions
- **Does cosine >= 0.97 drop "Launch is Sept 22" -> "Launch moved to Sept 15"?** No for that pair: cosine 0.822, stored, old fact superseded (the Titan wording: 0.903, also fine). But the gate does drop real corrections: **6 of 28 correction pairs (21%) were discarded as duplicates** and the old value stayed live, all numeric or one-token date changes with cosine 0.971 to 0.992 ("Wren has 12 engineers" -> "15 engineers", "Gossamer retention is 30 days" -> "90 days", "Sable churn 2.1%" -> "3.4%", "first Tuesday" -> "second Tuesday"). Correction cosines span 0.778 to 0.992 and paraphrase cosines 0.889 to 0.986: **no threshold separates them**, so a similarity gate alone cannot be right. Fix direction: when a near-duplicate differs in a number or date token, send it to the contradiction check instead of dropping it.
- **Paraphrase churn:** of 8 paraphrase pairs, 37.5% were deduped, **62.5% were stored as a second live row**, and 50% wrongly superseded the original (the contradiction check treats a rewording as a replacement). Supersede accuracy overall 0.75 (owner changes 6/6, updates 2/2, retractions 4/4, unrelated 4/4, numeric 3/8, paraphrase 4/8).

## Per set
| Set | n | Retrieval pass | Answer correct (judge) | Unsupported claims | Notes |
|---|---|---|---|---|---|
| qa | 80 | 0.838 | 0.888 | 0.010 | token-match 0.75 (formats such as "November 15, 2026" vs 2026-11-15) |
| multihop | 15 | 0.600 | 0.800 | 0 | 2 of 3 failures are empty answers |
| aggregation | 15 | 0.800 | 0.667 | 0.043 | agg-03 invented a sixth office (Berlin) from another set's data |
| temporal | 20 | 0.850 | 0.700 | 0.053 | as-of 0.70, relative 0.83, latest 0.50 (latest-value questions that return the old value) |
| abstention | 30 | 0.833 grounded | recall 0.633 | 0.091 | traps 6/8, unknown entities 9/16, secrets 4/6; 7 of the misses are empty answers, not fabrications |
| supersede | 40 | n/a | accuracy 0.75 | n/a | see above |
| drift (5 x 244 facts) | 230 queries | n/a | current-value recall 0.895 | n/a | stale leak 0.042, expired-fact leak 0, duplicate rows 0.001, un-superseded updates 0.018, exact repeats deduped 0.80 |
| extraction (60) | 60 | n/a | fact recall 0.868, token precision 0.903, judge precision 0.986 | n/a | date accuracy 0.941, 1.2 facts per transcript, 19 messages dropped by the secret filter, 14% of chat-only transcripts yielded a fact |

## Findings to act on
1. **Empty answers**: 16 of 160 answers (10%) stayed empty after a retry; finish reasons were `error` (33 occurrences) and `length`. This inflates the abstention and multihop failures and is the largest single defect the run found. Check whether production hides it behind a fallback.
2. **Dedupe gate drops numeric/date corrections** (above) and **rewordings churn** into duplicate rows.
3. **Secret stored**: 1 forbidden secret-related fact was stored through the real ambient path (filter + extractor) and 1 through the raw extractor with the regex filter bypassed (8 secret transcripts); see `failures.extraction` in the report for which transcript.
4. Extraction misses coreference-style owner facts (ex-22 "mine", ex-18, ex-36, ex-38) and states a rejected option beside the chosen one (ex-01), which the `forbid` rule counts.
5. Temporal "latest" questions answer with the older value half the time.

## Deterministic PR baseline (`server/test/eval/baseline.json`)
Fake embedder, no LLM: qa 0.963, multihop 0.80, aggregation 0.867, temporal 1.0, abstention 0.867, drift current-value recall 0.995, stale leak 0.142, duplicate rate 0.119. The drift stale leak is high here because the bag-of-words embedder ranks other entities' facts that share a value above the old fact, so the contradiction check's 5 nearest neighbours miss it; the real-embedding figure above is 0.042.
