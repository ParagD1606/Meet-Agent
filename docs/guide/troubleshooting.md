# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Huddle import fails, log says `missing_scope` (`canvases:read` or `files:read`) | Slack app was not reinstalled after the manifest gained the scope | Paste `docs/slack-app-manifest.yaml`, Install App > Reinstall to Workspace, then Meeting notes > Sync. See [slack](slack.md). |
| Huddle notes never appear, log `huddle skipped: bot is not in the channel` | Bot is not a member of the channel the huddle was in | Invite the bot, then Sync |
| Notion (or another app) write is refused: "writes are disabled for workspace connections" | Org writes setting is off | Admin: Integrations > workspace writes on, or enable that one connection. See [integrations](integrations.md). |
| A write waits on an Approve card | Its action class needs a card, it is destructive or unknown, or outside text entered the turn | Approve it (15 minute window), or change Pixel page > Approvals for card-free classes |
| Pixel says "I only have Notion" / cannot see GitHub | The app exists only as someone else's personal connection | Connect your own, request teammate access, or ask an admin to make it workspace-wide |
| Reply ends "I ran out of working room" | The turn hit its step cap | Say "continue". If it repeats on simple questions, check Turns for looping tools |
| Reply contains raw `call: ...` text | The model emitted a tool call as text instead of a tool call | Never reaches Slack by design; if seen, report the turn id. Try another model under Models |
| App Home shows an `invalid_arguments` error | A view exceeded Slack block limits or contained invalid text | Fixed in code and covered by the replay suite (scenario 11); update to the latest deploy |
| Vertex `429` / `Resource exhausted` | Project quota for the model | Wait, request a quota increase, set `MODEL_FALLBACK`, or pick another model under Models |
| Provider 400 mentioning `thought_signature` | Gemini thinking models need their signatures passed back with tool calls | Switch the role to a model without that requirement, or update the deploy; check the Turns error |
| Ambient memory is not learning | Bot is not in the channel; channel paused (`/brain-pause`) or opted out; channel set to quiet; message too short or looks like a secret; hourly cap reached | Invite the bot; `/brain-resume`; check Proactivity; see [ambient-capture](ambient-capture.md) |
| Facts are learned slowly | `MEMORY_FRESHNESS=normal` batches (20 messages or 5 min idle) | Learn now (admin) or `fast` for demos. See [setup](setup.md) |
| Pixel answers an old topic, or the chat feels bloated and slow | Long conversation history | Say `new chat` (or `/brain-new` in a DM). Memory, tasks and notes are kept. DMs idle for 6h (admin: `dm_idle_reset_hours`) start fresh automatically. Pixel suggests this itself once per 20 turns when a chat gets long. |
| A teammate's DM request ("create a task for ...") was treated as the answer to a question Pixel asked them | Older builds captured any DM from the person Pixel asked | Fixed: only a non-request, non-question DM that a small classifier calls an answer is captured; answering in the thread under the question always works. Admin kill switch for the classifier: setting `owner_reply_classifier` = `off` (request guard stays on). |
| Slash command "not found" or `dispatch_failed` | Manifest changed but Slack app not updated | Paste the manifest and reinstall the app |
| Nudges arrive at odd hours, or not at all | Workspace hours/timezone, or `QUIET_HOURS=1` holding them | Pixel page > Workspace hours; see [tasks](tasks.md) |
| `/readyz` returns 503 | db, boss or model check failing | See [operations](operations.md) |
| Integration shows "needs reconnect" | Authorization expired or revoked | Click Reconnect; admins and owners were DM'd once |
