# Overview

Company Brain is one Slack app plus a web console, backed by Postgres (pgvector). It answers questions from the company's memory, uses connected tools (MCP servers) on behalf of the person asking, and runs scheduled work.

## When it speaks
- **@mention or DM**: always answers.
- **Unprompted ("chime-in")**: only in channels where the bot is a member and the channel is proactive. A cheap triage step decides whether to answer, acknowledge or stay silent. Budget: at most 3 chimes per hour per channel and at least 5 minutes between them.
- **Proactivity** (Configure > Proactivity): the org default is `all` (every channel the bot is in) or `own` (only `#company-brain`). Each channel can be set to *proactive* or *quiet*. Quiet channels never get unprompted replies; DMs and @mentions are unaffected.

## What each turn can use
Memory search over the scopes visible in that conversation, web search/extract (if a search provider is configured), people search, skills, and tools from the asker's connected apps. Write actions in connected apps always wait for the asker's approval ([permissions](permissions.md)).

## Where to look
The web console (`PUBLIC_URL`) has Home (overview and recent turns), Graph and Memories, Configure (integrations, models, skills, automations, proactivity, workspace prompt, sync, tokens) and Turns (every run with tools, tokens and cost).

## Skills
A skill is a short playbook (a `SKILL.md` with `name` and `description` front matter). The model sees a one-line index and loads a body only when relevant (`load_skill`, bodies are capped at 8,000 characters). Admins manage org skills; any member can keep personal skills (up to 20) that only they can see and use. Upload with *Configure > Skills* or `POST /api/skills/upload`. Saving a skill needs the version you loaded; a stale save returns 409 and you must reload.
