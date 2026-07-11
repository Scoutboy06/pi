import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Result of checking divergence between local and remote.
 */
export interface Divergence {
  behind: number;
  ahead: number;
}

/**
 * Result of a full status check against the pi config repo.
 */
export interface RepoStatus {
  repoPath: string;
  divergence: Divergence;
  dirty: boolean;
  hasConflicts: boolean;
}

/**
 * Abstraction over git operations so tests can mock without a real repo.
 */
export interface GitClient {
  /** Find the git repository root starting from `fromPath`. Returns null if not in a repo. */
  findRepoRoot(fromPath: string): Promise<string | null>;

  /** Fetch from the configured remote. */
  fetch(repoPath: string): Promise<void>;

  /**
   * Returns left-right counts for @{upstream}...HEAD.
   * Format: "behind\tahead".  Returns null if no upstream is configured.
   */
  getDivergence(repoPath: string): Promise<Divergence | null>;

  /** Whether the working tree has uncommitted changes (tracked or untracked). */
  hasUncommittedChanges(repoPath: string): Promise<boolean>;

  /**
   * Check if merging @{upstream} into HEAD would produce conflicts.
   * Must be called after fetch so @{upstream} is current.
   */
  hasConflicts(repoPath: string): Promise<boolean>;

  /** Pull with rebase and autostash. Returns success and combined stdout/stderr. */
  pullRebase(repoPath: string): Promise<{ success: boolean; output: string }>;
}

/**
 * Real git client that delegates to `pi.exec`.
 */
export class PiExecGitClient implements GitClient {
  constructor(private readonly pi: ExtensionAPI) {}

  async findRepoRoot(fromPath: string): Promise<string | null> {
    const { stdout, code } = await this.pi.exec("git", [
      "-C",
      fromPath,
      "rev-parse",
      "--show-toplevel",
    ]);
    return code === 0 ? stdout.trim() : null;
  }

  async fetch(repoPath: string): Promise<void> {
    await this.pi.exec("git", ["-C", repoPath, "fetch", "--quiet"]);
  }

  async getDivergence(repoPath: string): Promise<Divergence | null> {
    const { stdout, code } = await this.pi.exec("git", [
      "-C",
      repoPath,
      "rev-list",
      "--left-right",
      "--count",
      "@{upstream}...HEAD",
    ]);
    if (code !== 0 || !stdout.trim()) return null;

    const parts = stdout.trim().split("\t");
    if (parts.length !== 2) return null;

    const behind = Number(parts[0]);
    const ahead = Number(parts[1]);
    if (isNaN(behind) || isNaN(ahead)) return null;

    return { behind, ahead };
  }

  async hasUncommittedChanges(repoPath: string): Promise<boolean> {
    const { stdout } = await this.pi.exec("git", ["-C", repoPath, "status", "--porcelain"]);
    return stdout.trim().length > 0;
  }

  async hasConflicts(repoPath: string): Promise<boolean> {
    // Get merge base
    const { stdout: mergeBase, code: baseCode } = await this.pi.exec("git", [
      "-C",
      repoPath,
      "merge-base",
      "HEAD",
      "@{upstream}",
    ]);
    if (baseCode !== 0 || !mergeBase.trim()) return true; // no common ancestor → assume conflict

    // Simulate merge with merge-tree. If output contains conflict markers, there are conflicts.
    const { stdout: mergeResult } = await this.pi.exec("git", [
      "-C",
      repoPath,
      "merge-tree",
      mergeBase.trim(),
      "HEAD",
      "@{upstream}",
    ]);

    return (
      mergeResult.includes("<<<<<<<") ||
      mergeResult.includes(">>>>>>>") ||
      mergeResult.includes("=======")
    );
  }

  async pullRebase(repoPath: string): Promise<{ success: boolean; output: string }> {
    const { stdout, stderr, code } = await this.pi.exec("git", [
      "-C",
      repoPath,
      "pull",
      "--rebase",
      "--autostash",
    ]);
    return {
      success: code === 0,
      output: [stdout, stderr].filter(Boolean).join("\n").trim(),
    };
  }
}
