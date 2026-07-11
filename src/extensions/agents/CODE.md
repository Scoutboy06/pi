# CODE.md — Agents Extension

## Overview

Persona-based agent delegation. Agents are markdown definitions with YAML frontmatter that specify a system prompt, optional model, and optional tool restrictions. The extension provides three invocation paths that share the same agent definitions and core runner.

## Architecture

```
agents/
├── index.ts              # Entry point: registers input handler, CLI flag, tool, events
├── src/
│   ├── agent-loader.ts   # AgentLoader: discovery & parsing from four locations
│   ├── agent-runner.ts   # AgentRunner: apply/clear persona, spawn sub-agents
│   └── agent-tool.ts     # Agent tool registration and rendering
├── tests/
│   ├── agent-loader.test.ts
│   ├── agent-runner.test.ts
│   └── agent-tool.test.ts
├── CODE.md
└── README.md
```

## Design Decisions

| Decision                                    | Rationale                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Single extension for all invocation paths   | Shared agent discovery and runner logic; agents and sub-agents are the same concept from different callers |
| Persona persists until changed              | `/agent:explorer` switches persona, `/agent:default` reverts — consistent mental model                     |
| Sub-agent spawns separate pi process        | Isolated context window, same approach as official subagent example                                        |
| Parallel/chain modes for tool delegation    | Enables complex multi-agent workflows; same approach as official subagent example                          |
| Agent's system prompt replaces pi's default | The agent IS the persona — mixing defaults would dilute the role                                           |

## Invocation Paths

| Path                   | Who invokes    | What happens                                                    |
| ---------------------- | -------------- | --------------------------------------------------------------- |
| `/agent:<name> [task]` | User types it  | Replaces current session persona (persistent)                   |
| `/agent:default`       | User types it  | Reverts to pi's built-in default                                |
| `--agent <name>`       | CLI flag       | Applies persona at session start                                |
| `agent("name", task)`  | LLM calls tool | Spawns isolated sub-agent, supports single/parallel/chain modes |

## Agent Definition Format

```markdown
---
name: explorer
description: Fast, read-only agent for codebase exploration
model: claude-haiku-4-5
tools: read, grep, find, ls
---

You are a codebase explorer. Your job is to search, discover, and understand code quickly.
```

- `name` (required) — unique identifier
- `description` (required) — when to use this agent
- `model` (optional) — model to use; falls back to current model
- `tools` (optional) — comma-separated tool list; falls back to all default tools

## Discovery Locations (priority order)

| Priority    | Location                                | Source label |
| ----------- | --------------------------------------- | ------------ |
| 1 (highest) | `.pi/agents/*.md` (cwd + ancestors)     | project      |
| 2           | `.agents/agents/*.md` (cwd + ancestors) | project      |
| 3           | `src/agents/*.md` (config repo)         | config       |
| 4 (lowest)  | `~/.pi/agent/agents/*.md`               | global       |
