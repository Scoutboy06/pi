# CODE.md - Pi configuration

## Project Overview

This repository contains personal Pi configuration resources. All changes to the Pi configuration should be made here. This includes custom agents, skills, prompt templates, extensions, and themes.

## Workflow

- When writing code, regularly typecheck, lint, and test your code for errors.

  - Typecheck: `bun typecheck`
  - Lint: `bun lint --format=agent` (auto-fix: `bun lint:fix --format=agent`)
  - Format: `bun fmt` (check: `bun fmt:check`)

- Husky hooks:
  - `pre-commit`: auto-fixes formatting and lint on staged files (via `git stash --keep-index`), then verifies with `fmt:check` + `lint` + `typecheck`.
  - `pre-push`: pure verification — `fmt:check` + `lint` + `typecheck`.
