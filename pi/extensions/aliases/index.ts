/**
 * Aliases Extension
 *
 * Declarative command aliases. Each entry specifies the target command,
 * its aliases, and whether to wait for the agent to become idle first.
 *
 * Current aliases:
 *   /clear, /reset  →  /new  (with wait)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

// ── Alias definitions ───────────────────────────────────────────

const aliasDefs = [
  { cmd: "new", aliases: ["clear", "reset"], wait: true },
] as const;

// ── Target implementations ──────────────────────────────────────
//
// Add new targets here when introducing a new `cmd` value.

const targets: Record<string, Handler> = {
  new: async (_args, ctx) => {
    await ctx.newSession();
  },
};

// ── Registration ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  for (const { cmd, aliases, wait } of aliasDefs) {
    const impl = targets[cmd];
    if (!impl) {
      console.error(`[aliases] unknown target: /${cmd}`);
      continue;
    }

    const handler: Handler = wait
      ? async (args, ctx) => {
          await ctx.waitForIdle();
          await impl(args, ctx);
        }
      : impl;

    for (const name of aliases) {
      pi.registerCommand(name, {
        description: `Alias for /${cmd}`,
        handler,
      });
    }
  }
}