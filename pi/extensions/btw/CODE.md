# Code.md — BTW Extension

## Overview

`/btw` lets you ask a quick side question without polluting the main conversation.
Inspired by Claude Code's `/btw`.

## Architecture

```
btw/
├── index.ts              # Entry point: registers /btw command
├── src/
│   ├── btw-command.ts    # BtwCommand: orchestrates side query lifecycle
│   └── btw-overlay.ts    # BtwOverlay: TUI popup component
├── tests/
│   ├── btw-command.test.ts
│   └── btw-overlay.test.ts
├── CODE.md
└── README.md
```

### Classes

- **BtwCommand** — collects conversation context, spawns an ephemeral
  sub-agent session (read-only tools, in-memory), collects the response,
  and displays it in an overlay. Handles timeouts and errors gracefully.

- **BtwOverlay** — a `Component` that renders a bordered popup anchored
  to the bottom of the terminal. Dismissible with `Esc`.

### Dependencies

- `@earendil-works/pi-coding-agent` — `createAgentSession`, `SessionManager`,
  `AuthStorage`, overlay API, `ExtensionCommandContext`
- `@earendil-works/pi-tui` — `truncateToWidth`, `visibleWidth`, `matchesKey`,
  `Key`, `Component`

### Design decisions

| Decision | Rationale |
|----------|-----------|
| Read-only tools (`read`, `grep`, `glob`, `ls`) | Safety for side queries |
| Ephemeral session (`SessionManager.inMemory()`) | Never persisted to disk |
| Same model as main session | Respects user's active model/agent |
| Only `text_delta` events collected | Hides reasoning/thinking from the output |
| 60-second timeout | Prevents runaway sub-agents |
| Overlay, not inline | Matches Claude Code UX — separate dismissible window |

## Gotchas

- **`DefaultResourceLoader` requires explicit `cwd` and `agentDir`** when used
  outside of Pi's main session bootstrap. Without them, internal path resolution
  may fail with a cryptic `startsWith` error. Pass `cwd: ctx.cwd` and
  `agentDir: getAgentDir()` from `@earendil-works/pi-coding-agent`.

## Testing

Unit tests cover:

- **BtwCommand** — `buildContextPrompt` (empty, populated, truncation, entry limit),
  `extractText` (plain strings, content blocks, edge cases)
- **BtwOverlay** — rendering (borders, title, body, footer), word wrapping,
  input handling (Esc closes, other keys ignored), caching/invalidation
