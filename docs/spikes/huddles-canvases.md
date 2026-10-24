# Spike: Slack huddle notes/transcripts and canvases (2026-10-24)

> **Current conclusion (supersedes "no read path" below):** `canvases.getContent` (scope `canvases:read`, `content_type: markdown`) works and returns canvas content, including Huddle notes. It is used first by `huddleCanvasText` in `server/src/meetings/index.ts`; the `url_private` download is only a fallback. Huddle notes are imported on `file_created` / `file_shared` / `file_change` events and on channel messages that attach a huddle canvas, by the admin's manual Sync (`POST /api/meetings/sync`), and as a backfill of older files. The bot must be in the channel. After pasting the manifest with `canvases:read`, reinstall the app. User guide: [../guide/slack.md](../guide/slack.md). The findings below are the original research and are kept for history. General (non-huddle) canvas ingestion into memory is still not built.

## Findings (from docs.slack.dev, fetched today)

- `canvases.sections.lookup` needs `canvases:read` (bot or user token) but returns **only section ids**, not content. Its ids exist to target `canvases.edit`.
- Documented canvas methods are create, edit and sections.lookup (plus listing via `files.list?types=canvas`). The canvases overview page documents **no method that returns canvas content** and no export.
- `files.info` (scope `files:read`) documents no canvas- or huddle-specific fields and no `url_private_download` for canvases. Only error codes mention canvases (disabled team, Slack Connect sharing blocked).
- Slack's help center says AI huddle notes land as a canvas in the huddle thread, with the transcript embedded in that canvas. The developer docs do not describe API access to huddle notes or transcripts.
- The existing manual fallback (`meetings/syncRecentHuddles`) reads `huddle_transcription` / `is_huddle_canvas` from `files.info` / `files.list`. Those fields are undocumented, so treat them as best effort. They are not a contract.

## Measured on the live bot (coordinator, with `files:read`)

`files.info` works for a huddle notes file (quip canvas) and its `huddle_transcript_file_id` (also a quip canvas), but neither carries inline `huddle_transcription` lines. The content is only reachable via `url_private` / `url_private_download` with `Authorization: Bearer <bot token>`. `ingestHuddleFile` now: uses inline lines if present, else follows `huddle_transcript_file_id`, else downloads the canvas (Slack hosts only, manual redirects so the token never leaves Slack), strips HTML to text, and summarizes it. A `missing_scope` error is logged and thrown naming the needed scope (`files:read`). Tests use a fake fetch (`test/meetings/huddle-canvas.test.ts`). The HTML layout of real canvases is unverified beyond text extraction; speaker/timestamp structure is kept only as far as `htmlToText` preserves line breaks.

This shows that downloading works for huddle canvases. General canvas ingestion into memory is still not built (see below).

## Recommendation

1. **Do not ingest canvases into memory yet.** No documented read path exists. Scraping `url_private` HTML with a bot token might work but is undocumented and could break without notice. Revisit if Slack ships a canvas read/export method, or if the Real-time Search / Slack MCP work (B2) exposes canvas content, which would also be user-scoped and ACL-correct.
2. Keep the manual huddle sync as the fallback. Meeting summaries and tasks now flow into memory (`rememberMeeting`: facts plus an episode, in the channel's write scope; an unknown channel counts as private).
3. Cheap validation before any canvas work: in a real workspace, run `files.info` on one huddle-notes canvas and one user canvas with the bot token and record which fields come back. That takes five minutes and settles the question.
4. Slack-uploaded files are a separate, documented path (`files.info` plus `url_private_download` with `files:read`) and can reuse `ingestDocument` with the channel tag. They were not part of this change.


## Update (after merge)
A teammate found `canvases.getContent` (scope `canvases:read`, `content_type: markdown`), which the docs pages above do not list. `huddleCanvasText` in `server/src/meetings/index.ts` uses it first; the url_private download path remains the fallback. `canvases:read` is in the manifest, so the Slack app must be reinstalled after pasting the new manifest.
