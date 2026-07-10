import { describe, expect, it, mock } from "bun:test";
import type { GitClient } from "../src/git-client";
import { UpdateCommand } from "../src/update-command";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockGitClient(overrides: Partial<GitClient> = {}): GitClient {
	return {
		findRepoRoot: async () => "/home/user/pi-config",
		fetch: async () => {},
		getDivergence: async () => ({ behind: 3, ahead: 0 }),
		hasUncommittedChanges: async () => false,
		hasConflicts: async () => false,
		pullRebase: async () => ({ success: true, output: "Fast-forward\n pi/extensions/git-updater/src/git-client.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)" }),
		...overrides,
	};
}

function makeMockCtx(overrides: Record<string, unknown> = {}) {
	return {
		ui: {
			notify: mock(() => {}),
			setStatus: mock(() => {}),
		},
		reload: mock(async () => {}),
		sessionManager: {
			getSessionFile: () => "/tmp/session.jsonl",
		},
		...overrides,
	} as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UpdateCommand.execute", () => {
	it("notifies warning when no git repo is found", async () => {
		const client = makeMockGitClient({ findRepoRoot: async () => null });
		const cmd = new UpdateCommand(client, "/fake/dir");
		const ctx = makeMockCtx();

		await cmd.execute(ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"No pi config git repository with upstream found",
			"warning",
		);
	});

	it("notifies warning when no upstream is configured", async () => {
		const client = makeMockGitClient({ getDivergence: async () => null });
		const cmd = new UpdateCommand(client, "/fake/dir");
		const ctx = makeMockCtx();

		await cmd.execute(ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"No pi config git repository with upstream found",
			"warning",
		);
	});

	it("notifies 'Already up to date' when behind is 0", async () => {
		const client = makeMockGitClient({
			getDivergence: async () => ({ behind: 0, ahead: 0 }),
		});
		const cmd = new UpdateCommand(client, "/fake/dir");
		const ctx = makeMockCtx();

		await cmd.execute(ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Already up to date", "info");
	});

	it("refuses to pull when there are conflicts", async () => {
		const client = makeMockGitClient({
			getDivergence: async () => ({ behind: 3, ahead: 2 }),
			hasConflicts: async () => true,
		});
		const cmd = new UpdateCommand(client, "/fake/dir");
		const ctx = makeMockCtx();

		await cmd.execute(ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Cannot update"),
			"warning",
		);
		// Pull should not have been called
		expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("git-updater", "Updating pi config...");
	});

	it("pulls successfully and reloads", async () => {
		const pullRebase = mock(async () => ({
			success: true,
			output: "Fast-forward\n file.ts | 1 +\n 1 file changed",
		}));
		const client = makeMockGitClient({ pullRebase });
		const cmd = new UpdateCommand(client, "/fake/dir");
		const ctx = makeMockCtx();

		await cmd.execute(ctx);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith("git-updater", "Updating pi config...");
		expect(pullRebase).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Updated"), "info");
		expect(ctx.reload).toHaveBeenCalledTimes(1);
	});

	it("handles pull failure", async () => {
		const client = makeMockGitClient({
			pullRebase: async () => ({
				success: false,
				output: "error: cannot pull with rebase: You have unstaged changes.",
			}),
		});
		const cmd = new UpdateCommand(client, "/fake/dir");
		const ctx = makeMockCtx();

		await cmd.execute(ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Update failed"),
			"error",
		);
		expect(ctx.reload).not.toHaveBeenCalled();
	});
});
