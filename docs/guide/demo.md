# Demo guide: fast memory, "learn now", ambient capture, demo data

## Seed a demo workspace

```sh
cd server
bun run scripts/seed-demo.ts --yes          # add --force only if NODE_ENV=production
```

Inserts a fictional company ("Orbital Tea Co."): 5 users, 4 channels, about 40 facts across `shared` and channel scopes
(entities, decisions with dates, procedures, preferences), a meeting summary, two commitments and one superseded fact
(the Reserve launch moved from October to November). It goes through the real `addFact` and entity pipeline, so it needs a
working embedding provider. Safe to re-run: facts whose text already exists are skipped. It refuses to run without `--yes`
and refuses `NODE_ENV=production` without `--force`. All content is invented.

## Fast freshness mode

| | normal (default) | fast |
|---|---|---|
| Thread capture | after 3 turns or 5 min idle | after every turn (15 s idle for anything left) |
| Idle sweep | every 10 min | every minute |
| Channel observe poll | every 30 min | every 2 min |
| Ambient channel buffer | 5 min quiet or 20 messages | 15 s quiet or 20 messages |
| Recall cache | 60 s | 5 s |
| Core-block snapshot in a thread | 6 h | 5 min (still stable inside one turn) |

Set it with `GET/PUT /api/settings/memory-freshness` (admin, body `{"mode":"fast"|"normal"}`) or the `MEMORY_FRESHNESS` env
default; the saved setting wins. Switching reschedules the cron jobs immediately. Fast mode makes many more model calls: turn it
off after the demo.

## Learn now (admin)

`POST /api/memory/run` with `{"job": "observe" | "consolidate" | "capture-flush" | "sync" | "backfill-prefix"}`.

- 200 `{ ok: true, job, ms, counts }`; counts depend on the job (observe: channels/messages/facts; capture-flush: facts; consolidate: the usual result; sync: huddles + sources).
- 409 `already_running` (one run per job at a time), 429 `rate_limited` with `Retry-After` (6 starts per minute per job), 500 `failed`.
- A new fact is visible to the next recall, and `/api/graph` and `/api/memories` answer `Cache-Control: no-store`.

## Ambient capture

The bot learns from every channel it is in, not only when mentioned. Public channel messages become `shared` facts; private channel
messages become `channel_<id>` facts only. DMs and group DMs are never observed. Slack message events are buffered per channel
(`ambient_messages`, keyed by channel + ts, so the polling job never double-adds) and extracted in batches. Messages that look like secrets
(tokens, passwords, card numbers, private keys) or prompt injection are dropped before storing. At most `MEMORY_AMBIENT_MAX_PER_HOUR` (default 60)
extraction calls per hour; the rest wait in the buffer.

- The bot posts a one-time notice in each channel. `/brain-pause` and `/brain-resume` (workspace admins or the channel creator) switch it per channel.
- `GET /api/channels/observe` (admin) lists channels with `observe`; `PUT /api/channels/:id/observe` `{"observe": boolean}` (admin) sets it. `false` is a sticky opt-out.
- Known gap: deleting a Slack message removes it from the buffer, but facts already extracted from it stay (use the Memory page to delete them).
