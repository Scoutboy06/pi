# Instruction Files

Adds compatible project instruction files that Pi does not load natively.

## Discovery

For every agent turn, the extension walks from filesystem root to Pi's current working directory. At each directory it adds instruction files in this order:

1. `AGENTS.md`, or `CLAUDE.md` when `AGENTS.md` is absent.
2. `AGENTS.local.md`, or `CLAUDE.local.md` when `AGENTS.local.md` is absent.

This gives `AGENTS` files precedence over their `CLAUDE` alternatives while letting deeper directories provide more specific instructions.

Pi already loads `AGENTS.md` context files. The extension excludes paths Pi reports as loaded and skips byte-identical content, so compatible files do not duplicate instructions.

## Disabling

Pass either `--no-context-files` or `-nc` to prevent the extension from injecting instruction files.
