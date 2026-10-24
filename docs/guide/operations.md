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
