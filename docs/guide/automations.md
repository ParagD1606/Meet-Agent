# Automations

Ask the bot in plain language ("remind me Friday 9am to send the report", "every Monday summarize open Linear issues in #eng") or use Configure > Automations.

| Kind | What it does |
|---|---|
| reminder | posts your text back at the time you choose (one-off `runAt` or cron) |
| digest | runs a **read-only** turn using org-shared tools and shared memory and posts the recap |
| research digest | a digest that runs a research pass each time (a watchlist) |

Rules
- Cron is 5-field and evaluated in **UTC**; the minimum interval is **1 hour**. One-off times must be at least 30 seconds ahead.
- Up to **20 automations per person**; admins can manage everyone's.
- The destination is your DM by default, or a channel. The bot first checks it can post there; if anything is ambiguous the run is skipped and the reason is stored as `lastStatus`. A private channel can be targeted only by an admin (API) or by one of its members (in Slack).
- Digests never use anyone's personal connections and never perform write actions.
- **Research** (`start_research`): plans sub-questions, runs them in parallel against memory, web and read-only tools, then posts one synthesized answer in the thread.
- Run now: *Run* button or `POST /api/automations/:id/run`.
