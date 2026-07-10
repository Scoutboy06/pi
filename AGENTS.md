# Pi Config Repository Instructions

This repository contains personal Pi configuration resources. All changes to the Pi configuration should be made here. This includes custom agents, skills, prompt templates, extensions, and themes.

## Conventions

- Keep general, cross-agent skills in the dotfiles-managed skills repo, not here.
- Use `pi/skills/` only for Pi-specific skills.
- Prefer prompt templates for reusable instructions that do not need extra files or workflows.
- Prefer extensions only when Pi runtime behavior needs to change.
- Keep extensions small, focused, and documented in `README.md`.

## CODE.md files

### Description

`CODE.md` files define hard requirements on folder and file structure.
For example; local conventions, patterns, constraints, and technical decisions.
The scope for each `CODE.md` file is the folder it resides in and all sub-folders.

### Actions

Before creating of modifying ANY file, locate all `CODE.md` files in scope:

1. Start by looking in the affected file's folder
2. Traverse up to repository root, locating `CODE.md` files along the way
   You MUST ALWAYS read `CODE.md` files fresh using the read tool - never rely on content from earlier in the conversation.
   You MUST look in EVERY folder along the path. You may NOT skip any folder.

Combine all found `CODE.md` files into a single instruction block.
If there are conflicting instructions, those that came from a file deeper in the structure take presedence.

You are NOT allowed to modify `CODE.md` files unless EXPLICITLY instructed to do so.
