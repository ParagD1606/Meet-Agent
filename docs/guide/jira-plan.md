# Jira integration plan

**Status: planned, not built.** Nothing on this page except the existing token sync exists in the product today.

## What exists today
- A token-based memory **sync provider** (`server/src/sync/providers/jira.ts`): Jira Cloud site URL, email and API token. It ingests summary, description and comments, per project key. Status, assignee and priority are live state and are **not** stored.
- Meeting notes can carry `jiraKey`/`jiraUrl` on extracted tasks.
- Pixel cannot search, create or change Jira issues, and does not answer "is PROJ-12 done?" from live data.

## Proposed: live actions through Atlassian Rovo MCP
Connect Atlassian's remote MCP server **v2**, `https://mcp.atlassian.com/v2/mcp`, as an ordinary connection (see [integrations](integrations.md)), using OAuth 2.1.

| Capability | Notes |
|---|---|
| JQL search, read issue | read class |
| Create, edit, transition, comment | write class (`ticket`), approval card per the Pixel approvals setting |
| Delete, manage/admin tools | **off by default**, controlled by the Atlassian admin; Pixel's classifier would card them anyway |

## Proposed: Tasks and Jira link
1. Add `commitments.external_ref` (for example `jira:PROJ-12`) to a task.
2. **Create issue from task**: a button or Pixel request creates the issue and stores the key.
3. **Transition on done**: marking the task done transitions the issue.
4. **Hourly reconcile**: a job reads linked issues and updates task status if Jira changed first. Jira stays the source of truth for status; memory keeps no status.

## Identity options
| Option | Acts as | Trade-off |
|---|---|---|
| Workspace connection | the admin who connected it; everything Pixel does appears as that admin | simple; weak audit trail, shared permissions |
| Personal connections | each person | correct attribution and permissions; every person must connect |

Recommendation to decide before building: workspace connection for reads, personal for writes.

## Costs
Rovo MCP calls consume Atlassian **Rovo credits, about 1 to 10 per call** depending on the tool. Search-heavy turns and the hourly reconcile need a budget; keep reconcile to linked issues only.

## Admin steps (Atlassian side)
1. Atlassian Administration > Connectors: allow the MCP client/app and its domain.
2. Confirm which tools are enabled (delete and manage stay off).
3. Check the Rovo credit allowance.
4. Then in Brain: Integrations > custom MCP server with the v2 URL, scope workspace or personal.

## Open questions
Credit budget, identity choice, whether Jira-to-task import is wanted, and the reconcile cadence.
