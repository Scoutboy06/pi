# Output Styles

Claude Code-like output styles for Pi. A style changes the role, tone, or response format by modifying the system prompt for every turn.

## Usage

- `/output-style` or `/style` opens the style picker.
- `/output-style Concise` selects a style directly.
- `pi --output-style Explanatory` selects the initial style.

The active style is shown beside the Pi editor as `style:<name>` and is stored in the current session, so it survives resume, reload, and branch navigation.

## Built-in styles

- **Default** — Pi's normal behavior
- **Proactive** — acts immediately and makes reasonable assumptions
- **Concise** — leads with the result and stays brief
- **Explanatory** — adds educational implementation insights
- **Learning** — collaborative learn-by-doing with `TODO(human)` contributions

## Custom styles

Create Markdown files in these locations:

- User: `~/.pi/agent/output-styles/*.md`
- Portable project: `.agents/output-styles/*.md`
- Pi project: `.pi/output-styles/*.md`

For trusted projects, both project directories are loaded from the Git repository root through the current working directory. A nearer definition overrides one with the same name farther away. Within the same directory, `.pi` overrides `.agents`. Project styles override user styles, and user styles can override built-ins.

```markdown
---
name: Diagrams first
description: Lead every explanation with a diagram
keep-coding-instructions: true
---

When explaining code, architecture, or data flow, start with a Mermaid diagram.
Keep diagrams under 15 nodes.
```

Frontmatter fields:

| Field                      | Purpose                                                     | Default           |
| -------------------------- | ----------------------------------------------------------- | ----------------- |
| `name`                     | Picker name                                                 | Markdown filename |
| `description`              | Picker description                                          | Source filename   |
| `keep-coding-instructions` | Append to Pi's normal system prompt instead of replacing it | `false`           |

When `keep-coding-instructions` is `false`, the style replaces Pi's standard coding system prompt with a minimal generic Pi prompt plus the style instructions. Project instructions, appended prompts, loaded skills, and tool schemas remain available.

Style files are rescanned whenever the picker or command is used, so newly created files do not require `/reload`.
