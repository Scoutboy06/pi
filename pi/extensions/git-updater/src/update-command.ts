import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GitClient } from "./git-client";
import { GitChecker } from "./git-checker";

/**
 * Handles the /update slash command: fetches and pulls the pi config repo.
 */
export class UpdateCommand {
	private readonly checker: GitChecker;

	constructor(
		private readonly gitClient: GitClient,
		extensionDir: string,
	) {
		this.checker = new GitChecker(gitClient, extensionDir);
	}

	/**
	 * Execute the /update command.  Flow:
	 *   1. Find repo root (→ fail if not a git repo with upstream).
	 *   2. Fetch and check status.
	 *   3. If no behind: "Already up to date".
	 *   4. If conflicts: refuse, tell user to resolve manually.
	 *   5. Otherwise: pull --rebase --autostash.
	 *   6. On success: clear status and trigger /reload.
	 */
	async execute(ctx: ExtensionCommandContext): Promise<void> {
		const result = await this.checker.check();

		if (!result) {
			ctx.ui.notify("No pi config git repository with upstream found", "warning");
			return;
		}

		const { repoStatus } = result;

		// Already up to date
		if (repoStatus.divergence.behind === 0) {
			this.checker.clear(ctx);
			ctx.ui.notify("Already up to date", "info");
			return;
		}

		// Conflicts — refuse to pull
		if (repoStatus.hasConflicts) {
			ctx.ui.notify(
				`Cannot update: ${repoStatus.divergence.behind} upstream change(s) conflict with ${repoStatus.divergence.ahead} local change(s). Resolve manually.`,
				"warning",
			);
			return;
		}

		// Pull
		ctx.ui.setStatus("git-updater", "Updating pi config...");

		const { success, output } = await this.gitClient.pullRebase(repoStatus.repoPath);

		if (!success) {
			ctx.ui.setStatus("git-updater", undefined);
			ctx.ui.notify(`Update failed:\n${output}`, "error");
			return;
		}

		// Clear status and reload
		this.checker.clear(ctx);
		ctx.ui.notify(`Updated: ${output || "pi config is now current"}`, "info");

		// Reload so new extensions, prompts, themes, and skills take effect.
		// ctx.reload() emits session_shutdown/start; code after it runs from the
		// pre-reload version, so return immediately.
		await ctx.reload();
	}
}
