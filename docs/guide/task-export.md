# Exporting and sending tasks

Approved tasks can leave Company Brain in two ways: send them to **GitHub** (issues, optionally on a Projects board) or download them (CSV, JSON, Markdown, Calendar). Trello is still supported but is tucked away (see the end).

## What can be exported or sent

- **Tasks** are the rows on the Tasks page (commitments). You only ever get tasks you can read there: a task from a private channel never appears in someone else's export or push.
- **Meeting items** are the items of one meeting. Only items that are `approved` tasks are ever sent. Proposed or rejected items, questions and suggestions are skipped with a reason.

## GitHub setup (admin)

Open **Integrations > Task boards**. The GitHub panel has four parts.

### 1. Connection (no second token needed)

- If an admin already connected GitHub under **Sync** (the GitHub App installation), the panel says **Using the GitHub connection already set up for sync**. Nothing to paste. Installation tokens last an hour; Company Brain mints a fresh one on demand. With several installations, the one that can see the chosen repository is used.
- Only if no installation exists, or you choose **Use a personal access token instead**, paste a token. It is stored encrypted and never shown again. Fine-grained: **Issues: Read and write** on the repository (plus **Projects** if you use a project). Classic: the `repo` scope (`project` for a project).
- If nothing is connected, the panel shows **Connect GitHub** (it takes you to the Sync page) or the token fallback.

### 2. Repository and labels

Pick the repository from the list of **all repositories the connection can access** (searchable, paginated). If listing is not possible you can type `owner/name`. Labels default to `pixel`; every issue also gets `due:YYYY-MM-DD` (when it has a due date) and `priority:urgent` (when urgent).

### 3. Owner mapping

Company Brain reads who can be assigned in the repository (collaborators, or the assignable users when the connection cannot list collaborators) and suggests a match for each person: exact email (high confidence), then GitHub login equal to the email name (medium), then identical full name (low). Press **Accept suggestions** or pick a login per person from the select. Suggestions never overwrite a mapping you set. An unmapped owner leaves the issue unassigned and the body says `Owner: <name>`. Ambiguous matches (two people with the same name) are never guessed.

### 4. Project board (optional)

Set **Project owner** (user or organization login) and **Project number** (the number in `.../projects/3`). After the issue is created it is added to that Project (v2) and, when the project has them, a date field named **Due** is filled and the single-select **Status** is set to **Todo**. A problem here never fails the issue: the result reads `issue created, project step failed: <reason>` and tells you which permission is missing. Optionally set a **Milestone number**.

### Test

**Test** creates nothing and reports each step: credential, repository, issues enabled, issue access, app permissions (for the GitHub App), and the project. A missing permission is named exactly, with the link to fix it.

### Required permissions

| Credential | Needs | For |
| --- | --- | --- |
| GitHub App | **Issues: Read & write** | creating and closing issues, reading assignees |
| GitHub App | **Metadata: Read** | listing repositories |
| GitHub App | **Organization projects: Read & write** | the optional Project board (organization-owned projects only; an app installation cannot reach a personal project, use a token for that) |
| Fine-grained token | Issues: Read & write, Metadata: Read, Projects: Read & write (if used) | same |
| Classic token | `repo` (and `project`) | same |

For the GitHub App, change permissions at `https://github.com/settings/apps/<app-slug>/permissions` (for an organization-owned app: the organization's Settings > Developer settings > GitHub Apps). After changing them, **an organization owner must approve the updated permissions** on the installation page, otherwise they do not take effect. The repository must also be selected in the installation's repository access.

## The issue

Title: the task title. Body: description, `Due:`, `Owner:`, `Source:` (the meeting or Slack thread link), the evidence quote for meeting items, `Created by Pixel from ...`, and a hidden marker `<!-- pixel-task:<id> -->` used to match the issue to its task. Labels as above; assignee when the owner is mapped.

## Sending

Use **Send to** on the Tasks page (selected tasks) or on a meeting (selected items, or all approved tasks). GitHub is listed first; Trello only appears when it is set up.

- Each task is sent once per board. Sending it again returns the existing link and creates nothing.
- Who may send: an admin, or the task's owner or assigner (for a meeting item: the organizer or the assignee).
- A result toast lists the created links and anything skipped or failed. Errors are explained: rejected credentials or a missing permission (401/403), a rate limit (429, with the wait time; a bulk send stops and marks the rest as not attempted), or a missing repository (404).
- Tasks that were sent show a GitHub link (`externalRefs` on `GET /api/tasks`; the `ExternalLinks` component in `web/ui/task-export.tsx` renders it).

## Two-way status

Each sent issue remembers the last state both sides agreed on (`open` or `closed`).

- **Closed on GitHub** (and the task is still open): the task is marked done (`not planned` closes it as dropped), the assigner gets the usual "completed" message with `closed on GitHub by <login>`.
- **Done or dropped in Pixel** (and the issue is open): the issue is closed (`completed` or `not planned`) with the comment `Marked done in Pixel`. This happens right away when you press Done, and the hourly check catches the rest.
- **Reopened** on either side reopens the other.
- It cannot loop: only the side that differs from the last agreed state is acted on, and the new state is recorded.
- The hourly job `github-reconcile` checks up to 100 issues per run (oldest check first), stops the whole run on a rate limit (`Retry-After`) or rejected credentials, and skips issues the connection cannot see. A closed, in-sync pair is watched for 30 days.

## Limits

- The repository picker shows the first 500 repositories the connection can access; type `owner/name` for others.
- Suggestions look at up to 100 assignable people; emails and names come from public GitHub profiles, so people with private profiles match by login only.
- One repository, one project and one milestone for all tasks (no per-channel routing yet).
- Reconcile reads one issue per request, 100 per hour.

## Downloads

Use the **Export** menu on the Tasks page (it exports the current filters) or on a meeting.

| Format | Notes |
| --- | --- |
| CSV | UTF-8 with a byte order mark so Excel reads accents correctly. Cells starting with `=`, `+`, `-` or `@` get a leading `'` so a spreadsheet never runs them as formulas. |
| JSON | `{ exportedAt, count, items: [...] }` |
| Markdown | Grouped by assignee, with due dates and links. |
| Calendar (.ics) | One to-do (VTODO) per task, with a stable UID so re-importing updates instead of duplicating. |

Over HTTP (signed in): `GET /api/tasks/export?format=csv|json|md|ics` with the Tasks page filters `status`, `owner`, `assigner`, `mine=1`, `overdue=1`, `unassigned=1`, `noDue=1`, `q`, `channel` (add `bom=0` to drop the CSV byte order mark); `GET /api/meetings/:id/export?format=json|csv|md|ics`.

## Audit

Every send (and failure) is written to `integration_pushes` (who, when, target, task, link, error or project warning, last synced state). Admins can read it at `GET /api/integrations/pushes`.

## Settings API (admin)

- `GET|PUT /api/settings/integrations/github-issues`: `{ repo, token?, usePat?, assigneeMap: { slackUserId: githubLogin }, labels, milestone?, projectOwner?, projectNumber? }`. `GET` also returns `credential: { kind: "app" | "pat" | "none", ... }` and never any token.
- `POST /api/settings/integrations/github-issues/test`: `{ ok, credential, checks: [{ name, ok, message }], message? }`.
- `GET /api/integrations/github/repos?q=&page=`: repositories the connection can access.
- `GET /api/integrations/github/suggestions?repo=owner/name`: assignable logins and suggested matches.
- `GET /api/integrations/targets` (any member): which boards are ready.

Send endpoints: `POST /api/tasks/:id/push`, `POST /api/tasks/push` (`{ target, ids }`), `POST /api/meetings/:id/items/:itemId/push`, `POST /api/meetings/:id/push` (`{ target, itemIds }` or `{ target, all: "approved" }`), with `target` `github` (or `trello`).

## Trello (optional)

Hidden by default. It appears under **Integrations > Task boards > Other boards** when already set up, or via **Add Trello (optional)**. Setup: create a Power-Up at <https://trello.com/power-ups/admin>, copy the API key, generate a read and write token, paste both and Save, then pick the board and list and optionally map members. **Test** calls `GET /members/me` and creates nothing. Settings API: `GET|PUT /api/settings/integrations/trello`, `POST .../trello/test`, `GET /api/integrations/trello/boards[/:id/lists|/members]`.
