# Code.md — BTW Extension

## Overview

`/btw` is a read-only side channel. It must never mutate files, persist data, or leak into the main conversation. Every design choice flows from that constraint.

## Architecture

```
btw/
├── index.ts              # Entry point: registers /btw command
├── src/
│   ├── btw-command.ts    # BtwCommand: orchestrates side query lifecycle
│   ├── btw-context.ts    # Context extraction for side queries
│   └── btw-overlay.ts    # BtwOverlay: TUI popup component
├── tests/
│   ├── btw-command.test.ts
│   └── btw-overlay.test.ts
├── CODE.md
└── README.md
```

## Design decisions

| Decision                                        | Rationale                                            |
| ----------------------------------------------- | ---------------------------------------------------- |
| Read-only tools (`read`, `grep`, `glob`, `ls`)  | Safety for side queries                              |
| Ephemeral session (`SessionManager.inMemory()`) | Never persisted to disk                              |
| Same model as main session                      | Respects user's active model/agent                   |
| Only `text_delta` events collected              | Hides reasoning/thinking from the output             |
| 60-second timeout                               | Prevents runaway sub-agents                          |
| Overlay, not inline                             | Matches Claude Code UX — separate dismissible window |
