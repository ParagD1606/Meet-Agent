# Brain Meeting Notes (Chrome extension)

A side panel that sits next to your call (Google Meet, Microsoft Teams, Zoom web client, Slack Huddles in the browser). It reads the on-screen captions; it does not record audio.

- **Live**: running transcript with speaker and time. "Catch me up" gives a late-joiner recap. "Import transcript" takes pasted text or a .txt/.vtt/.srt file instead of a live call.
- **Notes**: running notes (topics and open questions only) that refresh **every 2 minutes** while the call runs, when there are new lines. Decisions and tasks are deliberately *not* made live.
- **Items**: decisions, tasks and open questions, made **once, from the whole transcript** (press "Generate from whole transcript", or just finish the meeting), each with a badge (Confirmed commitment / Tentative / Suggestion / Open question), a one-line reason, and clickable `line N` evidence that jumps to and highlights the transcript line. Every item is Approve / Edit / Reject; nothing is sent until you approve it.
  - One-tap prompts when the owner or deadline is missing (roster names; Today / Tomorrow / Friday / Next week).
  - Banners for similar items (Merge / Keep both / Dismiss) and deadline conflicts.
  - Workload chip when someone already has 4+ open approved tasks across your saved meetings, suggesting the lightest teammate.
  - Relative dates ("next Friday") are resolved against the meeting's start time.
- **Ask**: chat about the meeting ("Who is free to take this?", "What did we decide?").
- **Settings**: server URL, token (saved automatically), auto-update (notes and items, every 2 minutes), auto-send.

"Finish & send to Meeting notes…" saves the transcript; Brain then reads the whole of it and writes the final decisions and tasks (owners are real participant names; anything it cannot quote from the transcript is dropped), and the panel shows the result and a link. When a live call ends, the same happens automatically unless switched off.

## Install
1. In Company Brain open **Meeting notes** and press **Get my token** (anyone signed in can; no admin needed). Meetings uploaded with it appear under your account.
2. `chrome://extensions` > Developer mode > Load unpacked > this folder. Reload it after updates.
3. Click the extension icon to open the panel, paste the token in Settings (once).

## Team memory
Ask also searches the team's memory (Slack conversations and what is in the Brain site) and shows which items it used, with a link back to the Slack thread when there is one. It reads memory as **you**: shared knowledge, your own DMs, and private channels you belong to, never anyone else's.

When decisions and tasks are written at the end, memory is given to the model only as background, to understand names, projects and references; every task and decision must still be quoted from the meeting itself, so memory can never create one. A relevant earlier item is mentioned in the summary as "Related earlier context".

Finished extension meetings are remembered too, **privately for the person who held them**, so you can later ask "what did we decide last time?".

## Names
Meet labels your own speech "You". The panel replaces it with your real name (from the participant list when it is open, otherwise the owner of your API token, or the name you type under Settings > You), so owners and the final notes use real names.

## What it can't do
- Attendee emails: Meet's page exposes display names only, so owners are names, not accounts.
- Notify anyone or create Jira/Slack tasks: items land in Meeting notes only.
- Contradiction detection between decisions: only similar-item and deadline conflicts are flagged.
- "Turn captions on" works for Meet only and depends on its button label.

Transcript lines and tracked items are sent to your own Brain server for detection and Q&A. Tell participants you are transcribing.

## Maintenance
Each platform's caption and roster DOM is in `adapters.js`; vendors change it without notice, and it is the only file to update when a platform stops capturing. The Slack adapter is untested. Pure logic lives in `lib.js` (`bun test extension/lib.test.js`).
