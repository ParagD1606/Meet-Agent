# Operations

## Jobs and schedules
All run on pg-boss in the same database, at-most-once (no retries, so a digest never double-posts). Cron times are UTC unless noted. Sources: `server/src/jobs.ts`, `manager/index.ts`, `memory/*.ts`, `sync/index.ts`, `automations/proactive.ts`.

| Job | Cron | Does |
|---|---|---|
| `automation-tick` | every minute | fires due automations |
| `manager-followups` | every minute | sends due follow-ups, daily and weekly task digests |
| `memory-reflect` | `*/10` (fast: every minute) | extracts idle threads |
| `memory-observe` | `*/30` (fast: `*/2`) | polls observed channels for missed messages |
| `memory-backfill` | `*/20` | bounded catch-up pass |
| `memory-backfill-history` | `23 * * * *` | history for channels the bot joined |
| `core-bootstrap` | `*/10` | first-time core-block bootstrap |
| `journey-tick` | `*/30` | onboarding nudges |
| `manager-extract` | `11 * * * *` (workspace tz) | commitment extraction |
| `manager-chase` | `41 * * * *` (workspace tz) | task nudges |
| `mcp-health` | `23 * * * *` | tests every connection |
| `sync-all` | `0 * * * *` | document sync sources |
| `deadline-reminders` | `17 * * * *` | deadline reminders |
| `manager-standup-daily` / `manager-risks` | `5 9` / `30 9`, Mon-Fri (workspace tz) | standup, risk scan |
| `manager-standup-weekly` | `0 16 * * 5` (workspace tz) | weekly status |
| `digest-weekly` | `0 9 * * 1` | channel digest |
| `members-resync` | `7 */6 * * *` | channel membership |
| `purge-old` | `17 3 * * *` | retention (below) |
| `memory-consolidate` | `17 3 * * *` | nightly consolidation, see [consolidation](consolidation.md) |

Workspace timezone and hours are applied at boot; restart after changing them. Admins can run memory jobs on demand (Learn now, `POST /api/memory/run`, jobs: observe, consolidate, capture-flush, sync, backfill-prefix, backfill-history, sync-tasks; one at a time, 6 starts per minute).

## Retention
Nightly `purge-old` deletes: events after 7 days, spilled tool results 30 days, turns 90 days (not running ones), approvals and leases 30 days after expiry, rate-limit rows 2 days, chime log 7 days, daily usage 400 days. Memories are never purged by it.

## What to check in logs
Logs are JSON lines on stdout (`docker compose logs app`). Useful messages: `jobs started` (boot), `purge`, `members resync`, `mcp health`, `commitment chase`, `follow-ups`, `ambient flush failed`, `history backfill failed`, `consolidation step failed` (names the step), `huddle skipped: bot is not in the channel`, `slack files.info missing scope`, `observe backlog truncated`. A `warn` per job is usually self-healing; repeated ones are not.

## Reading /readyz
`GET /readyz` returns `{ok, checks:{db, boss, model}, model}` and HTTP 503 until all three are true. `/healthz` is liveness only.

| Failing check | Meaning | Look at |
|---|---|---|
| `db` | `select 1` failed | Postgres up, `DATABASE_URL`, pool sizes |
| `boss` | jobs not started | boot log for migration or pg-boss errors |
| `model` | cached live model probe failed | key, quota (429), Vertex project; `model` holds the error |

## Deploy and rollback via CI
- Push to `main` runs `.github/workflows/ci-cd.yml`, which calls `scripts/ci-deploy.sh`: upload code (never `.env` or the ADC JSON), tag the running image `brain-app:previous`, `docker compose up --build -d`, wait for `/healthz`, run the live Vertex probe.
- If any step fails the script prints app logs and restarts the previous image automatically.
- That rolls back code only. Migrations are forward-only; to undo schema changes restore a database backup. See [setup](setup.md#rollback).
- Pull requests run type-checks, the web build and the full tests, including the [replay suite](replay-suite.md).
- Back up `pgdata` regularly. Losing `ENCRYPTION_KEY` makes stored tokens unreadable.

## Evaluation and the local gate
Deploys from `main` are not gated by CI tests (instant deploys, by choice). Two things replace the gate: a one-command local check before every push, and a nightly real-model evaluation that alerts.

### `bun run verify` (before every push)
Runs `scripts/verify.sh`. It starts its **own throwaway Postgres** (`initdb` on a free port, socket dir `/tmp/verify-5433-<pid>`, so it never touches your dev or production database; needs `initdb`, pgvector and pg_trgm installed system-wide) and runs, in order: server type-check, web type-check, web build, **every** `server/test/*/` directory separately (they share one database), `test/health.test.ts`, the memory-eval report against `baseline.json`, and an **upgrade rehearsal**. Then it prints a PASS/FAIL table, exits non-zero if anything failed, and always stops Postgres and removes the temp worktree and files (`VERIFY_KEEP=1` keeps the logs).
- Upgrade rehearsal: checks out `origin/main` (override with `VERIFY_BASE_REF=<commit>`) into a temp git worktree, runs its migrations on a second database, inserts a sample `memories` row, then runs this working tree's migrations on top. It asserts: the migration count went up (or stayed equal when the tree adds none), the sample row survived, journal `when` values are strictly increasing, new entries are newer than the base ref's last one (drizzle silently skips older ones), tags are unique and every tag has its `.sql` file.
- Known failure: on Postgres 18 (`postgres --version`) the hardening test `research enqueue twice` fails for an environmental reason. The script treats exactly that one failure as expected and prints a note, only when the major version is 18 or higher; anywhere else it is a real failure.
- `node_modules` is symlinked or installed (`bun install --frozen-lockfile`) only when absent.

### Evaluation program (`server/test/eval/`)
Gold sets are versioned JSONL (first line `{"_header":true,"set","version","date"}`) in `server/test/eval/gold/`: `extraction` (60 Slack-style transcripts with timestamps; expected facts, dates, owners, decisions, corrections, retractions, coreference, secrets that must not be stored), `qa` (80: 54 references into `memory-eval/cases.ts` plus 26 new), `supersede` (40 pairs), `abstention` (30, including tautology traps such as "Which city is our Berlin office in?", unknown entities and phone/wifi/secret requests), `multihop` (15), `aggregation` (15), `temporal` (20) and `drift/drift-1..5` (five 12-week timelines of 244 facts each with updates, duplicates, expiring facts, consolidation marks and dated queries). Edit the files, bump `version` and `date`, and run `UPDATE_BASELINE=1 bun test test/eval` to re-record the baseline.
- **PR subset** (`bun test test/eval`, about 30 s, part of `verify`): gold-file schema checks, scorer unit tests, and the deterministic recall of every set with the fake embedder plus the five drift timelines, compared with `baseline.json`. It fails on a drop of more than 2 points.
- **Nightly** (`server/scripts/eval-nightly.ts`, `bun run eval:nightly`): real Vertex (`MODEL_PROVIDER=vertex`, `gemini-embedding-001` at 1536 dims, answers on the `main` role, extraction and rewrite on the cheap role), seeded into a throwaway database through the real `addFact`, extraction through the ambient filter and `captureTurn`, answers built from the real system prompt plus recalled memory, judged claim by claim by a **different** model than the answerer. Hard budget (default $5, `--budget`), abort exit code 3. It refuses to run unless `DATABASE_URL` contains `5433` (or `--db <url>`), and it truncates that database. Writes `server/test/eval/last-nightly.json` (per-set metrics, deltas versus the previous file, the 0.97-gate and paraphrase-churn answers, failing items) and exits 1 on: `unsupported_claim_rate > 0.02`, `citation_validity < 1`, trap abstention below 5/6, a tracked recall metric more than 2 points below the previous run, or a secret stored through the ambient path.
- Run it locally: export a **throwaway** `DATABASE_URL` after loading `.env` (a sourced production `.env` would otherwise point at production, and the 5433 guard exists for that), plus `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_VERTEX_PROJECT`; e.g. `bun --env-file=.env scripts/eval-nightly.ts --budget 2`. Useful flags: `--sets qa,abstention`, `--limit 5` (smoke), `--out`, `--prev`.
- **GitHub**: `.github/workflows/nightly-eval.yml` (schedule 02:23 UTC and manual dispatch) starts a pgvector Postgres on port 5433, restores the previous report from the Actions cache, runs the script, uploads `eval-report` as an artifact and fails on a regression, which makes GitHub notify the repository owner. Secrets to create: `GCP_SA_JSON` (service account or ADC JSON with `roles/aiplatform.user`) and `GOOGLE_VERTEX_PROJECT`; optional variables `GOOGLE_VERTEX_LOCATION`, `GOOGLE_VERTEX_EMBED_LOCATION`. The cache is only saved by a passing run, so the comparison baseline is the last good night.
- Not built yet (Phase 1 and later): the script counts cost from provider usage and the `llm.ts` cost table; once the `llm_calls` ledger exists it should read spend from there. The answer step is a tool-less memory turn, not the full replay harness.
- Baseline numbers and how to read them: `docs/qa/eval-baseline.md`.

### Dashboards: data sources (no UI yet)
Trend pages should read, per night, `last-nightly.json` (Actions artifact `eval-report`, 60 days): `headline`, `sets.*`, `deltasVsPrevious`, `budget.spentUsd`. Live quality signals come from `recall_log` and `answer_checks` (Phase 1), `message_feedback` (thumbs), and `llm_calls` for cost and latency (Phase 1). None of these tables are required by the nightly today.
