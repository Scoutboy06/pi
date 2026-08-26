# Pi Config

Personal pi configuration package.

```
.
├── AGENTS.md
├── package.json
├── README.md
├── src/
│   ├── agents/                # Custom agent definitions (personas)
│   ├── extensions/            # Extensions: tools, commands, hooks, UI
│   │   ├── agents/            #   agent loading & delegation
│   │   ├── aliases/           #   command aliases
│   │   ├── btw/               #   /btw side-query command
│   │   ├── git-updater/       #   background git checker + /update
│   │   ├── instruction-files/ # compatible AGENTS/CLAUDE instruction loading
│   │   └── output-styles/     # response style picker + Markdown definitions
│   ├── prompts/               # Prompt templates (slash commands)
│   ├── skills/                # Pi-specific agent skills
│   └── themes/                # Pi themes
└── tsconfig.json
```

## Install

```bash
pi install .
```
