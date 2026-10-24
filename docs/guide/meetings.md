# Meetings

Turn a meeting transcript into decisions, action items, owners and deadlines, review them, and only then create tasks. Open **Meetings** in the console.

## Add a meeting
- **Paste** a transcript or notes into the box (best format: `Name: what they said`, one line per turn).
- **Upload** a `.txt`, `.vtt`, `.srt` or `.json` file with *Choose file* or by dropping it on the box (5 MB max).
- Optionally set a title and the meeting date.
- No transcript handy? *Load sample transcript* (clean) or *Load messy sample* (a duplicate task, a deadline conflict, a "maybe we should" suggestion and unresolved questions).
- Slack Huddles and the browser extension add meetings automatically.

While a meeting shows **Analysing**, the page checks every 2 seconds. A **Failed** meeting shows the reason and a *Retry* button.

## Reading the results
Items are grouped into: **Confirmed commitments**, **Tentative**, **Suggestions**, **Open questions** and **Decisions**. Each card shows:

| Badge | Meaning |
|---|---|
| confirmed | Someone clearly took it on. |
| tentative | Hedged, vague date, or partly specified. |
| suggestion | An idea ("maybe we should..."), not a commitment. |
| question | Raised but not answered. Nobody is assigned. |
| Needs owner / Which person? | No owner, or the name matches several people. Pick a suggested candidate or search. |
| Set date | No deadline was said. Pick one, or leave it. |
| No supporting quote | The model could not back this item with the transcript. It cannot be approved. |
| Low confidence | Below the auto-assign threshold; held for your review. |
| Auto-assigned | Assigned automatically. Task link and *Undo* shown. |
| Follow-up | Something to check on later. |

The confidence bar shows how sure the analysis is; hover it or open *Why / details* for the reason. The quote under each item links to its transcript lines (*line 12*), which opens the transcript with those lines highlighted.

## Duplicates and conflicts
- **Merged with...**: in automatic mode a duplicate of an existing task or earlier item is merged for you. *Undo merge* keeps both.
- **Looks like...** (amber, approval mode): choose *Merge* or *Keep both*.
- **Heads-up: conflicts with...** (amber): the same task has a different due date or owner elsewhere. It never blocks anything; *Resolve* opens the editor.

## Automatic assignment and review
The banner at the top says which mode is on. Admins switch with *Require approval before creating tasks and sending DMs* (off by default) and set the confidence threshold (default 60%).
- **Automatic (default)**: items at or above the threshold that have an owner and a supporting quote show **Auto-assigned**: the task is created and the owner notified. *Undo* drops the task.
- **Needs review**: only low-confidence items, items with *No supporting quote*, and items with no clear owner wait for you. Suggestions and questions are listed for reference; *Make it a task* promotes a suggestion into review.
- **Approval required**: nothing is assigned or sent until you approve.

Per item: **Approve**, **Edit** (title, description, owner, due date, priority, kind) or **Reject** (*Restore* later). With a card focused, press `a` to approve or `r` to reject. *Approve all needing review that have owners* skips items without an owner or quote and lists what was skipped. Only admins and the meeting owner can approve.

## After approval
Approved items show the real task state (linked to **Tasks**), whether the owner's DM is pending, sent, acknowledged or failed, and any Trello, GitHub or Jira links. *Send recap DMs* sends the owners a summary of their approved items.

## Tracking
The chips above the results show open actions, unassigned, no due date and overdue. The **Open actions** tab lists approved items that are not done, with their current task state.

## Export
The *Export* and *Push* menus copy or send the meeting's items to other tools (Trello, GitHub, Jira, files).
