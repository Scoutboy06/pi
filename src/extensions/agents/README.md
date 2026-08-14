# Agents

Persona-based agent delegation for pi. Define specialized agents as markdown files, then invoke them as slash commands, CLI flags, or tool calls.

## Architecture

| Layer            | Responsibility                                                                      |
| ---------------- | ----------------------------------------------------------------------------------- |
| **Entry Points** | `/agent:<name>`, `--agent <name>`, `agent()` tool — all share the same core         |
| **Agent Runner** | Configures persona (prompt, tools, model) and executes in-session or as a sub-agent |
| **Run Manager**  | Starts and controls detached persistent RPC workers                                 |
| **Run Registry** | Persists stable run IDs, hierarchy, lifecycle, activity, and session metadata       |
| **Agent Loader** | Discovers and parses agent `*.md` files from all configured locations               |

## Usage

### Slash command (replaces session persona)

```
/agent:explorer Find the authentication module
/agent:default
```

The persona persists until you switch to another agent or revert with `/agent:default`.

### CLI flag (applies at session start)

```bash
pi --agent explorer "Explore the codebase structure"
```

### LLM tool (delegates to sub-agent)

The model can call the `agent` tool to delegate focused tasks to specialized personas. Each sub-agent runs in an isolated process with its own context window.

**Modes:**

| Mode     | Parameters                           | Description                                            |
| -------- | ------------------------------------ | ------------------------------------------------------ |
| Single   | `{ agent, task, background? }`       | One agent, optionally a durable background RPC session |
| Parallel | `{ tasks: [{ agent, task, cwd? }] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain    | `{ chain: [{ agent, task, cwd? }] }` | Sequential execution with `{previous}` placeholder     |

**Scope control:**

- `agentScope: "user"` — bundled agents (`src/agents/`) and global agents (`~/.pi/agent/agents/`)
- `agentScope: "project"` — only project-local agents (`.pi/agents/`, `.agents/agents/`, `.claude/agents/`)
- `agentScope: "both"` — all locations, project overrides user (default for session persona, not for tool)
- Default tool scope is `"user"` for safety

**Security:** When `agentScope` includes project agents, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

**Output display:**

- **Collapsed view:** Status icon, agent name, last 10 tool calls/text items, usage stats (tokens, cost, turns, context)
- **Expanded view (Ctrl+O):** Full task text, all tool calls with formatted arguments (bash/read/write/edit/ls/find/grep), final output rendered as Markdown, per-task usage stats, aggregate totals
- **Streaming:** Live progress updates ("running...", "2/3 done, 1 running")

### Durable background runs

Set `background: true` in single mode to return immediately with a stable run ID. The detached worker keeps a persistent Pi RPC session alive after the parent Pi session exits.

Use the `agent_run` tool to:

- `list` or `get` run state
- send a new `message` when idle
- `steer` a working agent or queue a `follow_up`
- `abort` the current turn without ending the session
- `stop` the worker

Managed agents can call `agent_report_status` to explicitly report `working`, `paused`, or `blocked` with a detail. Lifecycle updates are emitted on the shared `agents:run-updated` event-bus channel. Records and persistent sessions live under `~/.pi/agent/agent-runs/` by default.

## Agent Definition Format

Create `.md` files with YAML frontmatter:

```markdown
---
name: explorer
description: Fast, read-only agent for searching and exploring codebases
model: openai-codex/gpt-5.6-luna
thinking: low
tools: read, grep, find, ls
---

You are a codebase explorer. Your job is to search, discover, and
understand code quickly.

When given a task:

1. Start with broad searches to map the relevant area
2. Drill into specific files for details
3. Report findings concisely
4. Do not edit or write files — you are read-only
```

### Fields

| Field         | Required | Description                                                                   |
| ------------- | -------- | ----------------------------------------------------------------------------- |
| `name`        | Yes      | Unique identifier for the agent                                               |
| `description` | Yes      | When to use this agent (shown to LLM)                                         |
| `model`       | No       | Model to use (e.g., `openai-codex/gpt-5.6-luna`). Falls back to current model |
| `thinking`    | No       | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`  |
| `tools`       | No       | Comma-separated tool list. Falls back to all default tools                    |

## Discovery Locations

Agents are discovered from five locations (in priority order — higher overrides lower):

| Priority    | Location                                | Scope   |
| ----------- | --------------------------------------- | ------- |
| 1 (highest) | `.pi/agents/*.md` (cwd + ancestors)     | Project |
| 2           | `.agents/agents/*.md` (cwd + ancestors) | Project |
| 3           | `.claude/agents/*.md` (cwd + ancestors) | Project |
| 4           | bundled `src/agents/*.md`               | Config  |
| 5 (lowest)  | `~/.pi/agent/agents/*.md`               | Global  |

Bundled definitions are resolved relative to the installed extension package, so they are available in every working directory as user-scoped agents. For trusted projects, `.claude/skills/` is also contributed to Pi through `resources_discover`. Native Pi agent definitions override Claude-compatible definitions with the same name.
