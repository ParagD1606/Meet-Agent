# Brain Meeting Notes (Chrome extension)

A side panel that sits next to your call (Google Meet, Microsoft Teams, Zoom web client, Slack Huddles in the browser):

- **Live**: the running transcript, by speaker.
- **Ask**: ask questions about the call so far ("What have we decided?", "Who is doing what?").
- **Tasks**: decisions and who-does-what. "Find decisions & tasks" asks the model to propose them from the transcript; you can add, assign, tick off and delete by hand. Kept per meeting on this device.
- **Settings**: server URL and API token, saved automatically.

The extension reads on-screen captions; it does not record audio. **Turn captions on in the call.** When the call ends the transcript is also sent to Meeting notes in the web app (switch off in Settings).

## Install
1. In Company Brain create an API token (Configure > API tokens).
2. `chrome://extensions` > Developer mode > Load unpacked > this folder.
3. Click the extension icon to open the side panel, paste the token in Settings. It is saved; you do it once.

Questions and analysis send the transcript so far to your own Brain server only. Tell participants you are transcribing.

## Maintenance
Each platform's caption DOM is in `adapters.js` and changes without notice. It is the only file to update when a platform stops capturing; the Slack adapter is untested.
