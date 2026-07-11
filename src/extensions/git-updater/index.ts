import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PiExecGitClient } from "./src/git-client.js";
import { GitChecker } from "./src/git-checker.js";
import { UpdateCommand } from "./src/update-command.js";

/** How often to check for updates in the background (5 minutes). */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export default function (pi: ExtensionAPI) {
  const extensionDir = import.meta.dirname;

  const gitClient = new PiExecGitClient(pi);
  const checker = new GitChecker(gitClient, extensionDir);
  const updateCommand = new UpdateCommand(gitClient, extensionDir);

  // Stored across the session lifecycle so the periodic timer can
  // update the footer.  Set in session_start, cleared in session_shutdown.
  let sessionCtx: ExtensionContext | null = null;
  let checkInterval: ReturnType<typeof setInterval> | null = null;

  // ── Periodic check ────────────────────────────────────────
  async function runPeriodicCheck(): Promise<void> {
    if (!sessionCtx) return;

    const result = await checker.check();
    if (result) {
      checker.displayResult(result, sessionCtx);
    } else {
      // No git repo or no upstream — clear any stale status
      checker.clear(sessionCtx);
    }
  }

  // ── Session lifecycle ─────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    sessionCtx = ctx;

    // Initial check
    await runPeriodicCheck();

    // Start periodic background checks
    checkInterval = setInterval(runPeriodicCheck, CHECK_INTERVAL_MS);
  });

  pi.on("session_shutdown", () => {
    sessionCtx = null;

    if (checkInterval !== null) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
  });

  // ── /update command ───────────────────────────────────────
  pi.registerCommand("update", {
    description: "Update pi configuration from git (fetch + pull --rebase)",
    handler: async (_args, ctx) => {
      await updateCommand.execute(ctx);
    },
  });
}
