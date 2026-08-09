# Undo Extension Design

## Goal

Add an `/undo` command that abandons the latest user turn within the current session file and restores that user's text to the input editor.

## Behavior

- The command only operates while Pi is idle. If an agent run is active, it warns the user and makes no changes.
- It searches the active branch for the latest user-message entry.
- It extracts string content or joins all text blocks from structured content.
- It navigates to the entry immediately preceding that user message without summarizing the abandoned branch.
- If the user message is the first entry, it resets the session leaf to the root position.
- It places the extracted text in the editor. Images are not restored.
- If no user message exists, it informs the user and makes no changes.

## Architecture

The extension lives in `src/extensions/undo/`. A small `UndoCommand` class encapsulates branch inspection, text extraction, navigation, and UI feedback. The entry point constructs the command and registers it with Pi.

Normal navigation uses the supported `ExtensionCommandContext.navigateTree()` API so Pi refreshes conversation state correctly. The first-entry edge case uses `SessionManager.resetLeaf()` because tree navigation requires a target entry ID.

## Error Handling

A cancelled tree navigation leaves the editor unchanged. Unsupported or image-only user content restores an empty editor while warning that images cannot be restored.

## Testing

Unit tests cover:

- undoing a normal completed turn;
- undoing the first user message;
- no user messages;
- refusal while busy;
- string and structured text extraction;
- cancelled navigation;
- image-only content.
