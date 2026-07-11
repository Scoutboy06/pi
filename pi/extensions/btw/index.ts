import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BtwCommand } from "./src/btw-command.js";

export default function (pi: ExtensionAPI) {
  const btwCommand = new BtwCommand();

  pi.registerCommand("btw", {
    description: "Ask a side question without affecting the main conversation",
    handler: async (args, ctx) => {
      if (!args || args.trim().length === 0) {
        ctx.ui.notify("Usage: /btw <question>", "warning");
        return;
      }
      await btwCommand.execute(args, ctx, pi);
    },
  });
}
