# Company Brain guide

A Slack teammate that remembers what your team says, answers from it, and acts in your tools. These pages describe how this deployment behaves.

| Page | Read it to |
|---|---|
| [overview](overview.md) | understand what the bot does and when it speaks |
| [setup](setup.md) | install it: env, Slack app, first sign-in, tuning variables, rollback |
| [slack](slack.md) | slash commands, manifest changes, huddle notes import |
| [permissions](permissions.md) | know who can see and do what |
| [connectors](connectors.md) | connect GitHub, Linear, Notion... and browse the marketplace |
| [integrations](integrations.md) | workspace vs personal connections, write approvals, health, reconnecting |
| [automations](automations.md) | schedule reminders, digests and research |
| [persona](persona.md) | rename the bot (default Pixel) and set its voice |
| [memory](memory.md) | see what is remembered, how it is scoped, corrected and exported |
| [ambient-capture](ambient-capture.md) | what Pixel learns from channels, and how to pause or opt out |
| [tasks](tasks.md) | assign, track and chase tasks from Slack and the Tasks tab |
| [consolidation](consolidation.md) | nightly memory clean-up, the review queue and undo |
| [tokens-and-limits](tokens-and-limits.md) | control cost and understand rate limits |
| [operations](operations.md) | jobs and schedules, retention, logs, `/readyz`, deploy and rollback |
| [troubleshooting](troubleshooting.md) | symptom, cause, fix |
| [replay-suite](replay-suite.md) | regression tests built from real Slack bugs |
| [jira-plan](jira-plan.md) | the planned (not built) live Jira integration |

The Slack app manifest is [`../slack-app-manifest.yaml`](../slack-app-manifest.yaml). Huddle notes background: [`../spikes/huddles-canvases.md`](../spikes/huddles-canvases.md).
