# Pi Config

Personal pi configuration package.

```
.
├── AGENTS.md
├── package.json
├── README.md
├──src/
│   ├── agents/          # Custom agent definitions (personas)
│   ├── extensions/      # Extensions: tools, commands, hooks, UI
│   │   ├── agents/      #   agent loading & delegation
│   │   ├── aliases/     #   command aliases
│   │   ├── btw/         #   /btw side-query command
│   │   └── git-updater/ #  background git checker + /update
│   ├── prompts/         # Prompt templates (slash commands)
│   ├── skills/          # Pi-specific agent skills
│   ├── skills/          # Pi-specific agent skills
│   └── lib/             # Shared utility code (not loaded by pi)
└── tsconfig.json
```

## Install

```bash
pi install .
```
