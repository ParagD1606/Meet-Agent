# Ambient capture

Pixel learns from what people say in channels it is in, so it can answer later without being asked to "remember". Code: `server/src/memory/ambient.ts`, `backfill.ts`, `server/src/slack/ambient-hook.ts`, `ambient-commands.ts`.

## What is learned
- Every human message in a channel where the bot is a member, buffered and extracted in debounced per-channel batches (20 messages or 5 minutes idle; much faster in `fast` freshness, see [setup](setup.md)).
- Not learned: DMs, messages to the bot (mentions are handled as turns), bot messages, messages under 20 characters, trivial chatter (thanks, emoji only), and anything that looks like a secret or a prompt injection.
- Task-like messages ("X will do Y by Friday") also become tasks, see [tasks](tasks.md).

## Scopes
Public channel: `shared`. Private channel: `channel_<id>` only, readable by that channel's members. See [memory](memory.md).

## Secrets filter
A message is dropped whole (nothing is stored) if it contains: Slack, GitHub, AWS, Google, Stripe or `sk-` style tokens, a PEM private key, `password`/`secret`/`api key`/`token`/`bearer` followed by `is`, `=` or `:` and a value, or a 13-19 digit run that looks like a card number. It is a best-effort filter, not a guarantee; tell people not to paste secrets.

## Pause, resume, opt out
| Action | Who | Effect |
|---|---|---|
| `/brain-pause` in a channel | workspace admins and the channel creator | Stops learning from this channel. What was learned stays. |
| `/brain-resume` | same | Learning resumes; the one-time notice is posted if it was never shown |
| Configure > Proactivity (`PUT /api/channels/:id/observe`) | admins | Opt a channel out (or back in) |
| Proactivity "quiet" for a channel | admins | Also stops capture there |

## Privacy
The first time it captures in a channel, Pixel posts one notice: "I learn from what's said in this channel... Admins can pause me here with `/brain-pause`." It is posted once per channel. Facts carry a Slack permalink to the source message. Admins can delete any memory (Memories page). Ambient extraction is capped per hour (`MEMORY_AMBIENT_MAX_PER_HOUR`, default 60).

## History backfill
When the bot joins a channel it reads back the last 30 days (setting `memory_backfill_days`, max 90) including thread replies, within a Slack-call budget per run (`MEMORY_BACKFILL_CALLS_PER_RUN`, default 20). It resumes where it stopped; an hourly job (minute 23) picks up channels missed while jobs were down. Admins can trigger it with Learn now (`POST /api/memory/run {job: "backfill-history"}`). Backfill creates tasks without chasing them.

## Edits and deletes
- Edit or delete before extraction: the buffered text is updated or removed.
- Edit or delete after extraction: if the facts came from that single message alone, they are retired and (for an edit) re-extracted from the new text.
- Gap: a fact distilled from several messages in one batch cannot be un-mixed, so it stays. Delete it in the Memories page. Edits that only change an unfurl or reply count are ignored.
