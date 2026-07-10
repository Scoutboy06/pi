# Pi Config

Personal pi configuration package.

```text
.
├── AGENTS.md
├── package.json
├── README.md
├── pi/
│   ├── agents/          # Custom agent definitions (personas)
│   ├── extensions/      # Extensions: tools, commands, hooks, UI
│   │   ├── agents/      #   agent loading & delegation
│   │   ├── btw/         #   /btw side-query command
│   │   └── git-updater/ #  background git checker + /update
│   ├── prompts/         # Prompt templates (slash commands)
│   ├── skills/          # Pi-specific agent skills
│   └── themes/          # Custom TUI themes
└── lib/                 # Shared utility code (not loaded by pi)
```

## Install

```bash
pi install .
```
