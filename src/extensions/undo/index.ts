import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { UndoCommand } from "./src/undo-command.js";

export default function (pi: ExtensionAPI) {
  const command = new UndoCommand();

  pi.registerCommand("undo", {
    description: "Undo the latest user turn and restore its text to the editor",
    handler: async (_args, ctx) => {
      await command.execute({
        isIdle: () => ctx.isIdle(),
        getBranch: () => ctx.sessionManager.getBranch(),
        navigateTree: (targetId) => ctx.navigateTree(targetId, { summarize: false }),
        resetLeaf: () => {
          const manager = ctx.sessionManager;
          if ("resetLeaf" in manager && typeof manager.resetLeaf === "function") {
            manager.resetLeaf();
          }
        },
        setEditorText: (text) => ctx.ui.setEditorText(text),
        notify: (message, level) => ctx.ui.notify(message, level),
      });
    },
  });
}
