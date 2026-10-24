# Regression replay suite

`server/test/replay/*.test.ts` replays the real bugs seen on live Slack, end to end through the real handlers
(`handleEventCallback` -> `runUserTurn` -> `runTurn` -> tools, owner-reply capture, interactions) with a real Postgres, a fake
Slack client (it remembers what was said, so history and thread reads look like Slack) and a model that is either scripted
or the real Vertex Gemini.

## Run

```sh
cd server
bun test test/replay                    # deterministic: scripted model, no network, runs in CI (part of `bun test test/*/`)
LIVE_MODEL=1 bun test test/replay       # also runs the live-model scenarios (real Gemini; never in CI)
```

Needs the usual test Postgres (pgvector + pg_trgm) in `DATABASE_URL` and `ENCRYPTION_KEY`, like the other test dirs.

Live mode needs Vertex credentials in the environment (do not copy them into the repo):

```sh
set -a; . /path/to/brain/.env; set +a
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/application_default_credentials.json
# keep DATABASE_URL pointing at the throwaway test database, not the one in .env
LIVE_MODEL=1 bun test test/replay
```

Live runs use the real chat model and real memory extraction, but a deterministic local embedder, and cost a few cents.
With `LIVE_MODEL=1` the scripted scenarios are skipped, so a live run only spends on the live ones. `REPLAY_LOGS=1` shows the app's JSON log lines.

## Scenarios

| File | Bug replayed | Deterministic | Live |
|---|---|---|---|
| 01-ambient-then-ask | facts posted in a channel, then "are you aware of this info?" answered about the company note | recent-channel + recalled facts reach the model, facts stored | answer cites the facts or says not in memory yet |
| 02-assign-task | "assign tales launch to @Parag, tell him it is urgent": task row, fact, immediate mention, `GET /api/tasks` | yes (Saturday night clock) | yes |
| 03-task-done | owner says "inform him the task is done": task done, fact superseded, assigner told | yes | yes |
| 04-owner-reply | owner answers an ask in a top-level DM; two-open-asks picker | yes | yes |
| 05-action-turns | "ok tell him ...", "say hello to @X", bare "continue": tools depth, real DM, no empty claim | yes | yes |
| 06-task-status-question | "is the X feature done?" answered from the task, no Jira/GitHub excuse | yes | yes |
| 07-pseudo-tool-text | `call:ask_teammate ... /` text never reaches Slack; near-miss argument names work | yes | yes |
| 08-working-room | simple memory questions never end with "ran out of working room"; repeated calls deduped | yes | yes |
| 09-resolve-button | Resolve buttons only under factual answers; clicking on an action ack stores nothing | yes | yes |
| 10-quiet-hours | default: no deferral on a Saturday night; `QUIET_HOURS=1`: deferral (chase, follow-up, ask) | yes | n/a (no model) |
| 11-home-view | App Home view obeys Slack block limits for 0/1/150 facts, admin/member, hostile text | yes | n/a |
| 12-scope-safety | private-channel task and fact never reach a non-member (API, tools, digests, lists, risks, turns) | yes (table) | n/a |

Bugs these scenarios found and that are now fixed are listed in the commit/PR that added the suite; each stays as its own test.

## Add a scenario

1. Copy the closest file. First line must be `import "../slack/env";` (config reads the environment at import time).
2. `beforeEach(async () => { slack = await boot(); })` seeds a workspace, users (`ME` Dana, `PARAG`, `DERP`, `UEVE`, an admin), a public
   channel `PUB`, a private channel `PRIV`, DMs, and installs the fake Slack, fake embedder and fake memory LLM. `afterAll(teardown)`.
3. Drive it with real Slack events: `await send(mention("..."))` (channel @mention), `send(dm("..."))`, `send(say("..."))` (plain
   channel message: ambient capture only). Interactions: `handleInteraction({ type: "block_actions", ... })`.
4. Script the model with `scriptModel((seen) => step)`. `seen.called("tool_name")` is true once that tool's result is in the prompt,
   `seen.prompt` / `seen.last` are the JSON prompt, `seen.toolChoice` shows the tool-less wrap-up step. A step is `{ text }`,
   `{ call, input }` or `{ calls: [...] }`. Make the script misbehave the way the real model did (raw `call:` text, "I'll let him know"
   with no tool, endless searching) and assert the system copes.
5. Assert on observable effects: DB rows (`commitments`, `memories`, `settings` ask rows, `turns`), Slack calls
   (`slack.posts()`, `slack.to(channel)`, `slack.calls`), HTTP (`app.request("/api/tasks")` with `createSession`). Never on exact wording.
6. Wrap the model-dependent test with `scriptedTest(...)` and add a `liveTest(...)` twin that calls `setLoopModel(); setModelResolverForTest();`
   and asserts only on effects. Keep live turns few; each costs real tokens.
7. A scenario that needs time: `setSystemTime(new Date("..."))` from `bun:test`, reset in `afterEach`.

Scenarios for MCP / Notion integrations belong here too (`13-...`): fake the MCP network with `fakeMcp()` from `test/turn/helpers.ts`.
