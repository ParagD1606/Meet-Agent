# Tokens and limits

The bot is built to spend as little as it can.

## Where the savings come from
- **Depth router**: greetings and thanks get one cheap call with no recall or tools; questions that need memory get recall only; tool-heavy asks get recall and the relevant tools; only hard asks get the full toolset and the higher step cap.
- **Stable prompt prefix**: instructions, workspace prompt, skills index and core blocks come first and identical for everyone in the workspace, so provider prompt caching hits. Skills show as one short line each; personal skills are appended after the shared ones.
- **Short history**: a rolling summary plus a recent window sized in tokens; long pasted blobs are stored and referenced.
- **Bounded recall**: memory is packed under a fixed budget (about 2,500 tokens).
- **Lazy tools and small results**: see [connectors](connectors.md).
- **Cheap models for chores**: triage, extraction and summaries use their own (cheaper) model roles; set them under Configure > Models, with an optional fallback provider.

## Limits (Configure > Usage and limits, admin)
Defaults: 400,000 tokens per turn, 2,000,000 per user per day, 20,000,000 per org per day, 8 concurrent turns, step caps of 2 / 4 / 12 / 30 for direct / memory / tools / deep. `0` disables a numeric cap. A turn that hits a ceiling stops with a friendly message.

## Rate limits
Per person about 5 requests/minute sustained (burst 10) and per channel burst 25; unprompted triage is limited per channel; MCP calls 1/second sustained per person. Over the limit the bot tells the user how many seconds to wait.

## Measuring
Every turn stores input/output/cache tokens, cost estimate, model, steps and a prompt breakdown (system, core blocks, skills, tool schemas, history, recall, tool results). The Turns page shows them; `GET /api/usage?range=7d|30d` aggregates by day, user, model and role, with the cache hit rate.
