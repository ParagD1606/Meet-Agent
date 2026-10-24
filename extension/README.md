# Brain Meeting Notes (Chrome extension)

Captures live captions from Google Meet, Microsoft Teams and Zoom (web client) and sends the transcript to your Company Brain, which summarizes it and extracts action items under **Meeting notes**. Slack Huddles are handled server-side and need no extension.

## Install
1. In Company Brain, create an API token (Configure > API tokens).
2. `chrome://extensions` > Developer mode > Load unpacked > select this folder.
3. Open the extension popup, enter your server URL and the token, Save, then Test.

## Use
Join a call and **turn captions on** (the extension reads the on-screen captions; it does not record audio). The transcript is sent when you leave the call, or press "Send transcript now" in the popup. A 30-second local backup is kept and retried if the server is unreachable.

Uploads are private to the uploader (and workspace admins). Tell participants you are transcribing.

## Maintenance
Each platform's caption DOM is in `adapters.js` and changes without notice; it is the only file to update when a platform stops capturing.
