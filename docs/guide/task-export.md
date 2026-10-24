# Exporting and sending tasks

Approved tasks can leave Company Brain in two ways: download them (CSV, JSON, Markdown, Calendar) or send them to a board (Trello cards, GitHub issues).

## What can be exported or sent

- **Tasks** are the rows on the Tasks page (commitments). You only ever get tasks you can read there: a task from a private channel never appears in someone else's export or push.
- **Meeting items** are the items of one meeting. Exports include everything with its approval state. Only items that are `approved` tasks are ever sent. Proposed or rejected items, questions and suggestions are skipped with a reason.

## Downloads

Use the **Export** menu on the Tasks page (it exports the current filters) or on a meeting.

| Format | Notes |
| --- | --- |
| CSV | UTF-8 with a byte order mark so Excel reads accents correctly. Cells starting with `=`, `+`, `-` or `@` get a leading `'` so a spreadsheet never runs them as formulas. |
| JSON | `{ exportedAt, count, items: [...] }` |
| Markdown | Grouped by assignee, with due dates and links. |
| Calendar (.ics) | One to-do (VTODO) per task, with a stable UID so re-importing updates instead of duplicating. |

The same downloads are available over HTTP (signed in):

- `GET /api/tasks/export?format=csv|json|md|ics` with the Tasks page filters `status`, `owner`, `assigner`, `mine=1`, `overdue=1`, `unassigned=1`, `noDue=1`, `q`, `channel`. Add `bom=0` to leave the CSV byte order mark out.
- `GET /api/meetings/:id/export?format=json|csv|md|ics` (you must be allowed to read the meeting).

## Trello setup (admin)

1. Open <https://trello.com/power-ups/admin>, create a Power-Up (or use an existing one) and copy its **API key**.
2. On the same page choose **Generate a new API key / Token** and authorize it with **read and write** access. Copy the **token**.
3. In the console go to **Integrations > Task boards > Trello**. Paste the key and token and press **Save**. The token is stored encrypted and is never shown again; only the last four characters of the key are displayed.
4. Pick the **board** and the **list** new cards go to, then **Save** again.
5. Optional: under **Member mapping** match people to Trello members. A card is assigned only when its owner is mapped; otherwise the description says `Owner: <name>`.
6. Press **Test**. It calls Trello's `GET /members/me` and creates nothing.

A card contains: the task title, description, a `Source:` link (the Slack message or the meeting), the evidence quote for meeting items, the due date, and `Created by Pixel from ...`.

## GitHub Issues setup (admin)

1. Create a personal access token. A fine-grained token limited to the repository with **Issues: Read and write** is enough (a classic token needs the `repo` scope, or `public_repo` for a public repository).
2. In **Integrations > Task boards > GitHub Issues** enter the repository as `owner/name` and paste the token, then **Save**. The token is stored encrypted.
3. Optional: set the labels (default `pixel`) and map people to GitHub logins. An issue is assigned only to a mapped login (it must have access to the repository).
4. Press **Test**. It calls `GET /repos/{owner}/{repo}` and creates nothing.

An issue contains the description, a `Source:` link, the evidence quote, `Due: YYYY-MM-DD`, an `Owner:` line, your labels and a `due:YYYY-MM-DD` label.

## Sending

Use **Send to** on the Tasks page (selected tasks) or on a meeting (selected items, or all approved tasks). Only boards that are set up are listed.

- Each task is sent once per board. Sending it again returns the existing link and creates nothing.
- Who may send: an admin, or the task's owner or assigner (for a meeting item: the organizer or the assignee).
- A result toast lists the created links and why anything was skipped or failed.
- Errors are explained: a rejected key or token (401/403), a rate limit (429, with the wait time; a bulk send stops and marks the rest as not attempted), or a missing board, list or repository (404).

### Audit

Every send (and failure) is written to the `integration_pushes` table (who, when, target, task, link, error). Admins can read it at `GET /api/integrations/pushes`.

## Settings API (admin)

- `GET|PUT /api/settings/integrations/trello`: `{ key, token, boardId, listId, memberMap: { slackUserId: trelloMemberId } }`. `GET` returns `{ configured, keyLast4, boardId, listId, memberMap }`, never the token. Omit `key` or `token` on `PUT` to keep the stored values.
- `POST /api/settings/integrations/trello/test`, `GET /api/integrations/trello/boards`, `/boards/:id/lists`, `/boards/:id/members`.
- `GET|PUT /api/settings/integrations/github-issues`: `{ repo, token?, assigneeMap: { slackUserId: githubLogin }, labels }`; `POST .../test`.
- `GET /api/integrations/targets` (any member): which boards are ready.

Send endpoints: `POST /api/tasks/:id/push`, `POST /api/tasks/push` (`{ target, ids }`), `POST /api/meetings/:id/items/:itemId/push`, `POST /api/meetings/:id/push` (`{ target, itemIds }` or `{ target, all: "approved" }`), with `target` `trello` or `github`.
