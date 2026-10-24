# Replay suite

Regression tests built from real bugs seen on live Slack. Each scenario drives the real handlers (event, turn, tools, interactions) with a real Postgres, a fake Slack client and either a scripted model or real Vertex Gemini.

```sh
cd server
bun test test/replay                 # deterministic, no network, runs in CI
LIVE_MODEL=1 bun test test/replay    # also runs live-model scenarios (a few cents, never in CI)
```

It covers ambient capture then ask, task assignment and completion, owner replies, action turns, pseudo-tool text, the "working room" cap, Resolve buttons, quiet hours, App Home limits, scope safety, Notion writes, teammate GitHub access and the integrations API (15 scenarios).

Run it before a risky change to turns, tools, memory or integrations. Full scenario table, live-mode setup and how to add a scenario: [`../qa/replay-suite.md`](../qa/replay-suite.md).
