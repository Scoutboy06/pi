# git-updater

Background git update checker and `/update` command for the pi configuration repository.

## Features

- **Background checker**: every 5 minutes, fetches and checks for upstream updates. Shows a footer status line when updates are available.
- **`/update` command**: fetches + pulls the pi config repo via `git pull --rebase --autostash`, then triggers `/reload` so new extensions, prompts, themes, and skills take effect.

## How it works

The extension detects the pi config repo by walking up from its own location (`import.meta.dirname`) using `git rev-parse --show-toplevel`. If the config was installed from npm (no `.git` directory), both features silently no-op.

### Status messages

| Situation | Footer / toast |
|-----------|---------------|
| Upstream updates only, clean tree | `3 updates — /update` |
| Diverged (local + remote), mergeable | `3 updates (↑2 ↓3) — /update` |
| Diverged with conflicts | `3 updates (↑2 ↓3) — conflicts — resolve manually` |
| Any of the above + uncommitted changes | Prefixed with `*` (e.g., `* 3 updates — /update`) |

`/update` refuses to pull when conflicts are detected.
