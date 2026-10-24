# Consolidation

A nightly job (03:17 UTC; also Learn now > consolidate) keeps memory tidy. It is idempotent: a second run changes nothing. Code: `server/src/memory/consolidate.ts`.

## Nightly steps
1. Seed entities from Slack people and channels.
2. **Merge** near-duplicate facts within a scope (similarity 0.95 or more): the more-used (then older) fact survives, the other is marked superseded.
3. **Cross-scope conflicts**: a channel or DM fact that duplicates or is contradicted by a newer shared fact is superseded by it. Shared facts are never changed because of narrower ones, and no merge widens visibility.
4. **Decay**: importance fades by fact type; at most once a day.
5. **Expire** transient facts past their date (after a 30 day grace).
6. **Summarise** stale clusters (180+ days, low importance, 8 or more facts) into a digest fact and archive the originals (kept, not purged).
7. **Propose** (review queue) promoting heavily used shared facts to the company core block, and demoting unused ones.
8. A per-channel "About:" line, per-entity summaries, and reusable procedures (procedures wait for admin approval).
9. Retention of operational data (spilled tool results, embedding cache, thread state).

A step that fails is logged (`consolidation step failed`) and the rest still run.

## Review queue
Console: Review queue; Slack: `/brain-review` (admins). Holds low-confidence facts, supersessions, shared writes, core-block edits, promotions and procedures. Approve or reject (`POST /api/reviews/:id/decide`). Pending items are not used in answers.

## Undo
Every change is logged in `consolidation_log` with a snapshot (`GET /api/consolidation-log`). An admin can reverse one entry (`POST /api/consolidation-log/:id/undo`): rows get their old status, pointer, importance and decay clock back, facts the action created are soft-deleted, its pending review is rejected, and a block line is put back or removed. Undo is idempotent; an entry already undone returns `already_undone`. A block that was edited since is changed line by line, not overwritten.

## Soft delete
Nothing here hard-deletes knowledge. Facts move to `superseded`, `archived` or `deleted` status with an invalid-at time and drop out of recall, but the rows stay for audit and undo. Deleting from the Memories page or `/forget` uses the same soft status.
