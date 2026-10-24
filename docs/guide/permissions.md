# Permissions

## Roles
| Role | Can |
|---|---|
| member | use the bot, connect personal apps, manage own automations and personal skills |
| admin | also: org connections, org skills, workspace prompt, proactivity, models, sync, API tokens, usage and limits, memory delete/export, review queue |
| owner | admin plus changing roles |

## Memory visibility
Each fact carries a scope tag: a public channel writes to `shared`; a private channel to `channel_<id>`; a DM to `user_<id>`. A conversation reads `shared` plus its own tag; a DM also reads the private channels that user belongs to. Public and private channels never widen into each other. See [memory](memory.md).

## Connected apps
- A person's **personal** connection is used only for their requests. Reads prefer the asker's own connection, then an org connection.
- **Writes** run under the asker's own personal connection when they have one; otherwise through a **workspace** connection when an admin allows it (Integrations > "Let the bot act through workspace connections", on by default; each connection can override it with Allow/Disable writes). Someone else's personal connection is never used for writes. Writes are never offered on read-only runs. By default four classes run immediately with no card: **tickets** (issues, comments), **Slack posts**, **doc edits** (Notion, Drive) and **email/calendar**. Email and calendar actions cannot be undone, so an admin can turn an **Approve / Deny** card back on for any class (`PUT /api/settings/approvals`, body `{"cards":{"email_calendar":true}}`). Deletes and anything not positively classified (merge, deploy, run, unknown verbs, `destructiveHint`) always post the card first (valid 15 minutes) and nothing runs until the asker approves. Read-only runs (digests, research) never receive write tools.
- Classification is fail-closed: a tool counts as a read only if it is positively identified (trusted `readOnlyHint` for curated servers, or a read verb like `list`/`get`/`search`); anything unknown is treated as a write. Tool descriptions are ignored.
- **Teammate access**: if the asker has no access to an app themselves, the bot can ask a teammate who has it to allow **one** read-only request (10 minute window, single use). The bot only offers this when the asker says they lack access ("I don't have access to Linear"); merely not having connected the app instead triggers a private Connect button.
- Mailboxes (Gmail) are personal only: never org-wide, never leased.

## Tokens and secrets
Connection tokens and bot tokens are encrypted at rest (AES-256-GCM). API tokens for the outward MCP server are stored hashed and read only the `shared` scope.

## Web console
Cookie sessions (30 days); state-changing API calls need the `x-requested-with: fetch` header.
