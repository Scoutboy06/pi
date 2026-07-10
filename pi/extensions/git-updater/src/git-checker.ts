import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GitClient, RepoStatus } from "./git-client";

/**
 * Summary after checking the pi config repo for updates.
 */
export interface CheckResult {
	statusText: string;
	/** True when there are remote updates that can be pulled. */
	canUpdate: boolean;
	repoStatus: RepoStatus;
}

/**
 * Orchestrates periodic git status checks for the pi config repository.
 */
export class GitChecker {
	constructor(
		private readonly gitClient: GitClient,
		private readonly extensionDir: string,
	) {}

	/**
	 * Run a full check: find repo, fetch, compute status.
	 * Returns null only when the extension is not inside a git repo
	 * or no upstream is configured.
	 *
	 * When behind=0 the result is still returned so callers can
	 * distinguish "already up to date" from "not a git repo".
	 */
	async check(): Promise<CheckResult | null> {
		const repoPath = await this.gitClient.findRepoRoot(this.extensionDir);
		if (!repoPath) return null;

		await this.gitClient.fetch(repoPath);

		const divergence = await this.gitClient.getDivergence(repoPath);
		if (!divergence) return null; // no upstream configured

		// Only do expensive checks when there's something to pull
		let dirty = false;
		let hasConflicts = false;

		if (divergence.behind > 0) {
			dirty = await this.gitClient.hasUncommittedChanges(repoPath);
			if (divergence.ahead > 0) {
				hasConflicts = await this.gitClient.hasConflicts(repoPath);
			}
		}

		const repoStatus: RepoStatus = {
			repoPath,
			divergence,
			dirty,
			hasConflicts,
		};

		return {
			statusText: this.formatStatus(repoStatus),
			canUpdate:
				divergence.behind > 0 && !hasConflicts,
			repoStatus,
		};
	}

	/**
	 * Format a status message from RepoStatus according to the scenario matrix.
	 *
	 *   A) behind > 0, ahead = 0, clean    → "N updates — /update"
	 *   B) behind = 0                      → "" (callers should clear/hide)
	 *   C) behind > 0, ahead > 0, clean    → "N updates (↑M ↓N) — /update"
	 *      (with conflicts)                → "N updates (↑M ↓N) — conflicts — resolve manually"
	 *   D) same as A/C but dirty           → prefix "* "
	 */
	formatStatus(status: RepoStatus): string {
		const { divergence, dirty, hasConflicts } = status;

		// Case B: nothing to pull — empty string so callers can clear
		if (divergence.behind === 0) return "";

		let message = `${divergence.behind} update${divergence.behind !== 1 ? "s" : ""}`;

		if (divergence.ahead > 0) {
			message += ` (↑${divergence.ahead} ↓${divergence.behind})`;
		}

		message += hasConflicts
			? " — conflicts — resolve manually"
			: ` — /update`;

		if (dirty) {
			message = `* ${message}`;
		}

		return message;
	}

	/**
	 * Display the check result to the user via setStatus (persistent footer)
	 * and notify (one-time toast) when updates are newly discovered.
	 */
	displayResult(result: CheckResult, ctx: ExtensionContext): void {
		// When there are no updates, just clear.
		if (!result.statusText) {
			this.clear(ctx);
			return;
		}

		ctx.ui.setStatus("git-updater", result.statusText);

		// Only toast when updates are newly available (not on every periodic check).
		// We track this with a simple flag.
		if (result.canUpdate && !this._lastToastShown) {
			ctx.ui.notify(result.statusText, "info");
			this._lastToastShown = true;
		} else if (!result.canUpdate) {
			this._lastToastShown = false;
		}
	}

	/** Clear the footer status and reset toast tracking. */
	clear(ctx: ExtensionContext): void {
		ctx.ui.setStatus("git-updater", undefined);
		this._lastToastShown = false;
	}

	// Internal: track whether we already toasted to avoid spamming on every tick.
	private _lastToastShown = false;
}
