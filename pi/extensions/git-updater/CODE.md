# Code.md — git-updater

## Architecture

```
index.ts                   # Entry point: wires events, registers /update command
src/
  git-client.ts            # GitClient interface + PiExecGitClient (wraps pi.exec)
  git-checker.ts           # GitChecker: orchestrates status checks, formats messages
  update-command.ts        # UpdateCommand: handles /update slash command
tests/
  git-checker.test.ts      # Unit tests for GitChecker (formatStatus, check, displayResult)
  update-command.test.ts   # Unit tests for UpdateCommand.execute
```

## Design

### GitClient (interface)

Abstraction over git operations. The real implementation (`PiExecGitClient`) delegates to `pi.exec`. Tests inject a mock implementation so no real git repo is needed.

### GitChecker

- `check()`: finds repo root, fetches, computes divergence/dirty/conflict status. Returns null when there's nothing to pull.
- `formatStatus()`: pure function mapping `RepoStatus` → status string according to the scenario matrix.
- `displayResult()`: updates footer status + shows one-time toast notification.

### UpdateCommand

- `/update` handler: checks status, pulls if clean, reloads on success.
- Refuses to pull when merge conflicts are detected.

## Scenario matrix

| Case | Behind | Ahead | Dirty | Conflict | Status |
|------|--------|-------|-------|----------|--------|
| A | >0 | 0 | No | — | `N updates — /update` |
| B | 0 | * | * | — | _(nothing shown)_ |
| C | >0 | >0 | No | No | `N updates (↑M ↓N) — /update` |
| C | >0 | >0 | No | Yes | `N updates (↑M ↓N) — conflicts — resolve manually` |
| D-A | >0 | 0 | Yes | — | `* N updates — /update` |
| D-C | >0 | >0 | Yes | No | `* N updates (↑M ↓N) — /update` |
| D-C | >0 | >0 | Yes | Yes | `* N updates (↑M ↓N) — conflicts — resolve manually` |
