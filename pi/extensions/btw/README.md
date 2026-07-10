# /btw

Ask a quick side question without polluting the main conversation.

Inspired by Claude Code's `/btw`.

## Usage

```
/btw What does this function return?
/btw How many files are in the src directory?
/btw What's the git status of the current branch?
```

The response appears in a popup at the bottom of the terminal.
Press **Esc** to dismiss. Nothing is added to the conversation history.

## Behavior

- **Forks context** — the sub-agent sees the last 30 conversation messages for context.
- **Read-only** — only `read`, `grep`, `glob`, and `ls` tools are available.
  No edits or destructive commands.
- **Reasoning hidden** — only the final response is shown, not the model's reasoning.
- **Ephemeral** — the sub-agent session is never persisted to disk.
- **Times out** — after 60 seconds the query is cancelled.
