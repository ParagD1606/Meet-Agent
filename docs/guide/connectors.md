# Connectors

Connectors are MCP servers. Each person connects their own account; admins can add org-wide ones.

## Connecting
- **In Slack**: ask for an app ("can you reach Figma?"). The bot searches the directory (`search_mcp_directory`) and, for OAuth apps, shows a **private Connect button** only you see. The button opens `PUBLIC_URL/mcp-connect/<id>`, which requires you to be signed in as the person the connection belongs to, then forwards you to the provider's consent screen. API-key apps cannot be connected from Slack (only you may enter your key): you get a link to Integrations.
- **In the web console**: Configure > Integrations. The marketplace lists about 150 curated remote MCP servers plus the built-in presets (GitHub, Linear, Notion, Sentry, Plain, PostHog, Granola, Gmail, Google Workspace). API: `GET /api/marketplace?q=` and `POST /api/marketplace/:key/install` with `{scope: "user"|"org", token?}`. Org installs need admin. `POST /api/marketplace/custom/install {url}` adds any public `https` MCP server.
- Custom URLs must be `https`, free of credentials and resolve to public addresses (private, loopback and link-local ranges are rejected, again on every connect).

## Big servers: search instead of listing
Apps with more than 12 tools are not listed in the model's tool schemas (that would cost thousands of tokens every turn). The model gets two small tools instead: `search_tools(query)` (keyword ranking over name and description) and `call_tool(name, args, fields?)`. The tool catalog is cached with the connection (5 minutes) rather than fetched each turn.

## Results
MCP output is minified before the model sees it: nulls, empty values, API-url and metadata fields and HTML are dropped. `call_tool` accepts `fields` (dot paths) to keep only what is needed. Results over about 1,500 characters are stored and replaced by a preview plus a handle the model can page through.

## Resilience
Calls to one connection run one at a time. A transport reset on a read is retried once. Failures come back as structured errors with a kind and a suggestion: `reauth` (reconnect needed), `rate_limited`, `timeout`, `server_error`, `not_found`, `invalid_input`, `tool_error`. A connection that needs re-authorization is marked `error` and shown in Integrations.
