# git-updater

Background git update checker and `/update` command for the pi configuration repository.

## Features

- **Background checker**: every 5 minutes, fetches and checks for upstream updates. Shows a footer status line when updates are available.
- **`/update` command**: pulls the pi config repo and reloads so new extensions, prompts, themes, and skills take effect.

## Status messages

| Situation                              | Footer / toast                                     |
| -------------------------------------- | -------------------------------------------------- |
| Upstream updates only, clean tree      | `3 updates — /update`                              |
| Diverged (local + remote), mergeable   | `3 updates (↑2 ↓3) — /update`                      |
| Diverged with conflicts                | `3 updates (↑2 ↓3) — conflicts — resolve manually` |
| Any of the above + uncommitted changes | Prefixed with `*` (e.g., `* 3 updates — /update`)  |

`/update` refuses to pull when conflicts are detected. When pull succeeds, a `/reload` is triggered automatically.
