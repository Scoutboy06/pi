import { describe, expect, it, mock } from "bun:test";
import type { GitClient, RepoStatus } from "../src/git-client";
import { GitChecker } from "../src/git-checker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatus(overrides: Partial<RepoStatus> = {}): RepoStatus {
  return {
    repoPath: "/home/user/pi-config",
    divergence: { behind: 3, ahead: 0 },
    dirty: false,
    hasConflicts: false,
    ...overrides,
  };
}

function makeMockGitClient(overrides: Partial<GitClient> = {}): GitClient {
  return {
    findRepoRoot: async () => "/home/user/pi-config",
    fetch: async () => {},
    getDivergence: async () => ({ behind: 3, ahead: 0 }),
    hasUncommittedChanges: async () => false,
    hasConflicts: async () => false,
    pullRebase: async () => ({ success: true, output: "Updated" }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatStatus
// ---------------------------------------------------------------------------

describe("GitChecker.formatStatus", () => {
  function makeChecker(): GitChecker {
    return new GitChecker(makeMockGitClient(), "/fake/dir");
  }

  // Case A: behind > 0, ahead = 0, clean
  it("case A — upstream updates only, clean tree", () => {
    const checker = makeChecker();
    expect(
      checker.formatStatus(makeStatus({ divergence: { behind: 3, ahead: 0 }, dirty: false })),
    ).toBe("3 updates — /update");
  });

  it("case A — singular update", () => {
    const checker = makeChecker();
    expect(
      checker.formatStatus(makeStatus({ divergence: { behind: 1, ahead: 0 }, dirty: false })),
    ).toBe("1 update — /update");
  });

  // Case B: behind = 0 → check() returns null, so formatStatus is never called for B

  // Case C clean: behind > 0, ahead > 0, no conflicts
  it("case C — diverged but mergeable", () => {
    const checker = makeChecker();
    expect(
      checker.formatStatus(
        makeStatus({ divergence: { behind: 3, ahead: 2 }, dirty: false, hasConflicts: false }),
      ),
    ).toBe("3 updates (↑2 ↓3) — /update");
  });

  // Case C conflict
  it("case C — diverged with conflicts", () => {
    const checker = makeChecker();
    expect(
      checker.formatStatus(
        makeStatus({ divergence: { behind: 3, ahead: 2 }, dirty: false, hasConflicts: true }),
      ),
    ).toBe("3 updates (↑2 ↓3) — conflicts — resolve manually");
  });

  // Case D-A: dirty + upstream only
  it("case D-A — dirty tree, upstream updates only", () => {
    const checker = makeChecker();
    expect(
      checker.formatStatus(makeStatus({ divergence: { behind: 3, ahead: 0 }, dirty: true })),
    ).toBe("* 3 updates — /update");
  });

  // Case D-C clean: dirty + diverged + mergeable
  it("case D-C — dirty, diverged, mergeable", () => {
    const checker = makeChecker();
    expect(
      checker.formatStatus(
        makeStatus({ divergence: { behind: 3, ahead: 2 }, dirty: true, hasConflicts: false }),
      ),
    ).toBe("* 3 updates (↑2 ↓3) — /update");
  });

  // Case D-C conflict
  it("case D-C — dirty, diverged, conflicts", () => {
    const checker = makeChecker();
    expect(
      checker.formatStatus(
        makeStatus({ divergence: { behind: 3, ahead: 2 }, dirty: true, hasConflicts: true }),
      ),
    ).toBe("* 3 updates (↑2 ↓3) — conflicts — resolve manually");
  });
});

// ---------------------------------------------------------------------------
// check()
// ---------------------------------------------------------------------------

describe("GitChecker.check", () => {
  it("returns null when not in a git repo", async () => {
    const client = makeMockGitClient({ findRepoRoot: async () => null });
    const checker = new GitChecker(client, "/fake/dir");
    expect(await checker.check()).toBeNull();
  });

  it("returns null when no upstream is configured", async () => {
    const client = makeMockGitClient({ getDivergence: async () => null });
    const checker = new GitChecker(client, "/fake/dir");
    expect(await checker.check()).toBeNull();
  });

  it("returns result with behind=0 (case B)", async () => {
    const client = makeMockGitClient({
      getDivergence: async () => ({ behind: 0, ahead: 5 }),
    });
    const checker = new GitChecker(client, "/fake/dir");
    const result = await checker.check();

    // Should return a result (not null) so callers can distinguish
    // "already up to date" from "not a git repo"
    expect(result).not.toBeNull();
    expect(result!.statusText).toBe("");
    expect(result!.canUpdate).toBe(false);
    expect(result!.repoStatus.divergence.behind).toBe(0);
  });

  it("returns result for case A (upstream only, clean)", async () => {
    const client = makeMockGitClient({
      getDivergence: async () => ({ behind: 2, ahead: 0 }),
      hasUncommittedChanges: async () => false,
    });
    const checker = new GitChecker(client, "/fake/dir");
    const result = await checker.check();

    expect(result).not.toBeNull();
    expect(result!.statusText).toBe("2 updates — /update");
    expect(result!.canUpdate).toBe(true);
    expect(result!.repoStatus.dirty).toBe(false);
    expect(result!.repoStatus.hasConflicts).toBe(false);
  });

  it("skips conflict check when ahead === 0", async () => {
    // Even if hasConflicts would return true, it shouldn't be called when ahead=0
    let conflictsCalled = false;
    const client = makeMockGitClient({
      getDivergence: async () => ({ behind: 2, ahead: 0 }),
      hasConflicts: async () => {
        conflictsCalled = true;
        return true;
      },
    });
    const checker = new GitChecker(client, "/fake/dir");
    const result = await checker.check();

    expect(conflictsCalled).toBe(false);
    expect(result!.repoStatus.hasConflicts).toBe(false);
  });

  it("returns result with conflicts when diverged and unmergeable", async () => {
    const client = makeMockGitClient({
      getDivergence: async () => ({ behind: 3, ahead: 2 }),
      hasConflicts: async () => true,
      hasUncommittedChanges: async () => false,
    });
    const checker = new GitChecker(client, "/fake/dir");
    const result = await checker.check();

    expect(result).not.toBeNull();
    expect(result!.canUpdate).toBe(false);
    expect(result!.repoStatus.hasConflicts).toBe(true);
    expect(result!.statusText).toContain("conflicts — resolve manually");
  });

  it("marks dirty when uncommitted changes exist", async () => {
    const client = makeMockGitClient({
      getDivergence: async () => ({ behind: 3, ahead: 0 }),
      hasUncommittedChanges: async () => true,
    });
    const checker = new GitChecker(client, "/fake/dir");
    const result = await checker.check();

    expect(result!.repoStatus.dirty).toBe(true);
    expect(result!.statusText).toMatch(/^\* /);
  });
});

// ---------------------------------------------------------------------------
// displayResult / toast tracking
// ---------------------------------------------------------------------------

describe("GitChecker.displayResult", () => {
  it("shows toast only on first canUpdate=true result", () => {
    const checker = new GitChecker(makeMockGitClient(), "/fake/dir");
    const result = {
      statusText: "3 updates — /update",
      canUpdate: true,
      repoStatus: makeStatus({ divergence: { behind: 3, ahead: 0 } }),
    };

    const ctx = {
      ui: {
        setStatus: mock(() => {}),
        notify: mock(() => {}),
      },
    } as any;

    // First call — should toast
    checker.displayResult(result, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);

    // Second call with same result — should NOT toast again
    checker.displayResult(result, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); // still 1
  });

  it("toasts again after a non-canUpdate result resets the flag", () => {
    const checker = new GitChecker(makeMockGitClient(), "/fake/dir");
    const updateResult = {
      statusText: "3 updates — /update",
      canUpdate: true,
      repoStatus: makeStatus(),
    };
    const conflictResult = {
      statusText: "3 updates (↑2 ↓3) — conflicts — resolve manually",
      canUpdate: false,
      repoStatus: makeStatus({ divergence: { behind: 3, ahead: 2 }, hasConflicts: true }),
    };

    const ctx = {
      ui: {
        setStatus: mock(() => {}),
        notify: mock(() => {}),
      },
    } as any;

    // First: update available → toast
    checker.displayResult(updateResult, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);

    // Then: conflicts appear → no toast, but resets flag
    checker.displayResult(conflictResult, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);

    // Then: update available again → toast fires again
    checker.displayResult(updateResult, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
  });

  it("clear removes the footer status", () => {
    const checker = new GitChecker(makeMockGitClient(), "/fake/dir");
    const ctx = {
      ui: {
        setStatus: mock(() => {}),
        notify: mock(() => {}),
      },
    } as any;

    checker.clear(ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("git-updater", undefined);
  });
});
