# Agents

Persona-based agent delegation for pi. Define specialized agents as markdown files, then invoke them as slash commands, CLI flags, or tool calls.

## Architecture

| Layer            | Responsibility                                                                      |
| ---------------- | ----------------------------------------------------------------------------------- |
| **Entry Points** | `/agent:<name>`, `--agent <name>`, `agent()` tool — all share the same core         |
| **Agent Runner** | Configures persona (prompt, tools, model) and executes in-session or as a sub-agent |
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
| Single   | `{ agent, task }`                    | One agent, one task                                    |
| Parallel | `{ tasks: [{ agent, task, cwd? }] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain    | `{ chain: [{ agent, task, cwd? }] }` | Sequential execution with `{previous}` placeholder     |

**Scope control:**

- `agentScope: "user"` — only global agents (`~/.pi/agent/agents/`, `pi/agents/`)
- `agentScope: "project"` — only project-local agents (`.pi/agents/`, `.agents/agents/`)
- `agentScope: "both"` — all locations, project overrides user (default for session persona, not for tool)
- Default tool scope is `"user"` for safety

**Security:** When `agentScope` includes project agents, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

**Output display:**

- **Collapsed view:** Status icon, agent name, last 10 tool calls/text items, usage stats (tokens, cost, turns, context)
- **Expanded view (Ctrl+O):** Full task text, all tool calls with formatted arguments (bash/read/write/edit/ls/find/grep), final output rendered as Markdown, per-task usage stats, aggregate totals
- **Streaming:** Live progress updates ("running...", "2/3 done, 1 running")

## Agent Definition Format

Create `.md` files with YAML frontmatter:

```markdown
---
name: explorer
description: Fast, read-only agent for searching and exploring codebases
model: claude-haiku-4-5
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

| Field         | Required | Description                                                                               |
| ------------- | -------- | ----------------------------------------------------------------------------------------- |
| `name`        | Yes      | Unique identifier for the agent                                                           |
| `description` | Yes      | When to use this agent (shown to LLM)                                                     |
| `model`       | No       | Model to use (e.g., `claude-haiku-4-5`, `deepseek-v4-flash`). Falls back to current model |
| `tools`       | No       | Comma-separated tool list. Falls back to all default tools                                |

## Discovery Locations

Agents are discovered from four locations (in priority order — higher overrides lower):

| Priority    | Location                                | Scope   |
| ----------- | --------------------------------------- | ------- |
| 1 (highest) | `.pi/agents/*.md` (cwd + ancestors)     | Project |
| 2           | `.agents/agents/*.md` (cwd + ancestors) | Project |
| 3           | `src/agents/*.md` (config repo)         | Config  |
| 4 (lowest)  | `~/.pi/agent/agents/*.md`               | Global  |
