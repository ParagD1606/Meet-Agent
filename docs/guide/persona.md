# Persona

The product is Company Brain; in Slack the bot goes by **Pixel** by default: a friendly, warm, concise, practical teammate. The persona changes voice only. Abilities, permissions, approval rules and safety rules are unchanged.

Admins can change it with `GET/PUT /api/settings/persona` (fields: `name` max 40, `role` max 80, `tone` max 400, `greeting` max 200 characters; blank role/tone fall back to the defaults, blank greeting becomes "Hi, I'm <name>. What can I help with?"). Text is scanned for prompt-injection like core memory and rejected if unsafe or if it contains `<` or `>`.

The persona is part of the cached system prompt prefix, so it changes only when settings change. It is used in DMs, channels, the assistant pane greeting, the welcome and channel intro messages and the App Home header.

## Slack display name and avatar

Bots cannot set their own profile (`users.profile.set` is unavailable), so the Slack display name comes from the app manifest (`features.bot_user.display_name: "Pixel"` in `docs/slack-app-manifest.yaml`). If you rename the persona, change the display name in Slack app settings too. The avatar is uploaded manually in the Slack app settings (Basic Information > Display Information > App icon).
