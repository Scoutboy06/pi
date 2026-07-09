# Elias Pi Config

Personal configuration package for [`pi`](https://pi.dev): extensions, prompt templates, themes, and any Pi-specific skills I want to keep separate from my main dotfiles/agent-skills repository.

## Structure

```text
.
├── pi/
│   ├── agents/      # Custom agent definitions (personas with model, tools, prompts)
│   ├── extensions/  # Pi TypeScript/JavaScript extensions: tools, commands, hooks, UI
│   ├── skills/      # Pi-specific Agent Skills only
│   ├── prompts/     # Reusable slash-command prompt templates
│   └── themes/      # Custom Pi TUI themes
└── lib/             # Shared utility code (not loaded by Pi)
```

### `pi/agents/`

Custom agent definitions — reusable personas with their own model, tool restrictions, and system prompt. Each `.md` file defines one agent via YAML frontmatter.

- `pi --agent code-reviewer` — run a session as that agent
- `/agent:code-reviewer` — switch agent mid-session
- The main agent automatically delegates to agents via the `agent` tool

Model aliases are configured in `pi/agents/models.json`. See the agents extension at `pi/extensions/agents/` for the implementation.

### `pi/extensions/`

Use for actual Pi behavior changes:

- custom tools
- custom slash commands
- permission/path guards
- status widgets
- session or model hooks
- custom compaction/checkpoint behavior

### `pi/skills/`

This repo is **not** the main home for general agent skills. Those live in my dotfiles repo.

Use this folder only for skills that are Pi-specific, such as workflows that depend on Pi commands, Pi extensions, Pi package behavior, or Pi-only conventions.

### `pi/prompts/`

Markdown prompt templates. Each `.md` file becomes a slash command in Pi.

Example:

```text
pi/prompts/review.md -> /review
```

### `pi/themes/`

Custom Pi TUI themes as JSON files.

### `lib/`

Shared utility code and helpers that extensions may import. This directory is not surfaced to Pi as a resource path — it’s just a code library.

## Local usage

Install this package into Pi from the local checkout:

```bash
pi install /home/elias/p/pi
```

Or test a single extension while developing:

```bash
pi -e ./extensions/my-extension.ts
```

After changing resources in an active Pi session, run:

```text
/reload
```

## Package manifest

This repo is configured as a Pi package through `package.json`:

```json
{
  "pi": {
    "extensions": ["./pi/extensions"],
    "skills": ["./pi/skills"],
    "prompts": ["./pi/prompts"],
    "themes": ["./pi/themes"]
  }
}
```

The `pi/agents/` directory is loaded by the agents extension, not via the pi manifest.

Pi can load it from this local path, a git repo, or npm if published later.

## Guiding principle

Start with prompts for quick reusable workflows, use skills for deeper Pi-specific instructions, and reach for extensions only when I need new runtime behavior.
