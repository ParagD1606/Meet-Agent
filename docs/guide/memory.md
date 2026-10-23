# Memory

## What is stored
- **Facts**: short statements (decisions, owners, deadlines, preferences) extracted from conversations, with source, time and a Slack permalink when known.
- **Document chunks**: from uploads (`POST /api/memories/upload`) and synced sources (Google Drive, OneDrive, Notion; hourly).
- **Core blocks**: three small always-on notes (company, channel, user) the bot can edit with `core_memory`; over-limit edits are rejected and shared company edits by non-admins go to the review queue.
- **Episodes**: a finished or long-idle thread is summarized in 3-6 sentences (decisions, owners, deadlines, open items) and stored in the thread's scope for later recall.

## Scoping
`shared` (public channels), `channel_<id>` (private channels) and `user_<id>` (DMs). See [permissions](permissions.md). Nothing leaves its scope: search always requires an explicit list of tags.

## Staying correct
When a new fact contradicts an older one in the same scope, the old one is marked superseded and given an end time; history is kept and visible in the console. Low-confidence or LLM-judged supersessions on shared memory create items in the **review queue** (Memories > Reviews) for an admin to approve or reject. A nightly job merges near-duplicates and decays unused facts. Ask "forget X" and the bot previews (`dryRun`) what it would remove.

## Passive learning
Channels can opt in to being observed: a periodic job reads new messages and extracts facts into that channel's own scope, respecting Quiet.

## Correcting and deleting
Admins can delete any memory (Memories page or `DELETE /api/memories/:id`).

## Export
Admins: `GET /api/export/memories` downloads active **shared** facts as Markdown, grouped by source. Private-channel and DM memories are never exported.

## Outward access
Create an API token (Configure > Tokens) and point any MCP client at `PUBLIC_URL/mcp` (Bearer token) to use `search_memory` and `list_recent`. Tokens only read `shared`.
