# Integrations

Console page: Integrations (`/integrations`). Basics of connecting are in [connectors](connectors.md); this page covers who a connection acts as, write approvals and health. Code: `server/src/mcp/*`.

## Workspace vs personal
| | Workspace (org) | Personal (user) |
|---|---|---|
| Created by | an admin | any member |
| Used for | everyone's requests | only its owner's requests (reads prefer it) |
| Acts as | the account that connected it | that person |
| Writes | follow the **org writes** setting, or a per-connection override | always allowed; the person is the actor |
| Reconnect alert goes to | all admins and owners | the owner |

An admin can promote a personal connection with "Make workspace-wide" (`POST /api/mcp/connections/:id/workspace`). Gmail is personal only; two workspace connections of the same app are refused. If someone asks for an app that exists only as another person's personal connection, Pixel says so, can request access from that person (one read, single use) and mentions an admin can share it. It does not say "I only have Notion".

## Org writes setting
Configure > Integrations (`GET/PUT /api/settings/mcp-writes`), default **on**. When off, members cannot trigger write tools through workspace connections and Pixel says an admin has to enable writes. An admin can override one connection (`PATCH /api/mcp/connections/:id {allowWrites: true|false|null}`; null inherits). Personal connections are unaffected.

## Approval classes
Pixel page > Approvals (`PUT /api/settings/approvals`). Writes are classified from the tool name (fail-closed; descriptions are ignored).

| Class | Examples | Card by default |
|---|---|---|
| `ticket` | issues, comments, tasks, PRs | no (admin can turn on) |
| `slack_post` | messages | no |
| `doc_edit` | pages, docs, files, databases | no |
| `email_calendar` | email, drafts, events | no |
| other | delete, merge, deploy, run, unknown verbs | always |

Also always carded: any write in a turn that has read outside text (Notion, web, etc.). Cards expire after 15 minutes.

## Test connection, health, reconnect
- **Test connection** (`POST /api/mcp/connections/:id/test`, owner or admin; someone else's personal connection is a 404): lists tools live and shows tool counts (read/write), latency and the error text.
- **Health**: an hourly job (minute 23) tests every connected app and records the result. A connection whose authorization expired becomes **needs reconnect** and one DM is sent per outage (to the owner, or to admins for a workspace connection) with a link to Integrations. It resets when the connection recovers. Admins can run it now (`POST /api/mcp/health/run`).
- **Reconnect**: click Reconnect on the row (re-runs OAuth or asks for a new token).

## How-tos
- **GitHub**: needs a personal access token (GitHub's MCP server has no OAuth registration). Choose scope workspace (admin) or personal, paste the token. Keep the token's repo access as narrow as you need.
- **Notion**: OAuth. A workspace connection writes as the admin who connected it, so pick an admin whose access you are happy to share. For writes by members, org writes must be on. Page edits can be carded (`doc_edit`). The memory sync for Notion pages (Sync page) is separate from live actions.
- **Jira**: today only the token-based memory sync (Sync page; site URL, email, API token; ingests summary, description, comments; no status). Live actions are planned, see [jira-plan](jira-plan.md).
