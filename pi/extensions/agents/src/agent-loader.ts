/**
 * Agent discovery and configuration.
 *
 * Scans for agent definitions (*.md files with YAML frontmatter) from:
 *   1. .pi/agents/*.md        (cwd + ancestors) — highest priority
 *   2. .agents/agents/*.md    (cwd + ancestors)
 *   3. pi/agents/*.md         (config repo, found by walking up from cwd)
 *   4. ~/.pi/agent/agents/*.md (global) — lowest priority
 *
 * Project agents override global agents with the same name.
 * Within the same scope, first discovered wins.
 *
 * Scope control via AgentScope:
 *   - "user":    only global (~/.pi/agent/agents/) and config repo (pi/agents/)
 *   - "project": only project-local (.pi/agents/, .agents/agents/)
 *   - "both":    all locations, project overrides user (default for session persona)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "project" | "config" | "global";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

// ── Frontmatter parsing ───────────────────────────────────────

interface AgentFrontmatter {
  name?: string;
  description?: string;
  tools?: string;
  model?: string;
}

function parseAgentFile(filePath: string, source: AgentConfig["source"]): AgentConfig | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

  if (!frontmatter.name || !frontmatter.description) {
    return null;
  }

  const tools = frontmatter.tools
    ?.split(",")
    .map((t: string) => t.trim())
    .filter(Boolean);

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    tools: tools && tools.length > 0 ? tools : undefined,
    model: frontmatter.model?.trim() || undefined,
    systemPrompt: body.trim(),
    source,
    filePath,
  };
}

// ── Directory scanning ─────────────────────────────────────────

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function loadAgentsFromDir(dir: string, source: AgentConfig["source"]): AgentConfig[] {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) {
    return agents;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    const agent = parseAgentFile(filePath, source);
    if (agent) {
      agents.push(agent);
    }
  }

  return agents;
}

// ── Ancestor walking ───────────────────────────────────────────

/**
 * Walk up from `startDir` looking for a subdirectory `relativePath`.
 * Returns the first found absolute path, or null.
 */
function findUp(startDir: string, relativePath: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, relativePath);
    if (isDirectory(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Find the nearest .pi/agents/ directory by walking up from cwd.
 * Used for project agent security confirmation (showing the source directory).
 */
function findNearestProjectAgentsDir(cwd: string): string | null {
  return findUp(cwd, `${CONFIG_DIR_NAME}/agents`);
}

// ── Scoped discovery ───────────────────────────────────────────

/**
 * Discover agents with scope control.
 *
 * Session persona commands (/agent:name, --agent) use full discovery (no scope param)
 * to always include all locations. The tool uses scope control for security.
 */
export function discoverAgentsScoped(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const globalDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const dotAgentsDir = findUp(cwd, ".agents/agents");
  const configAgentsDir = findUp(cwd, "pi/agents");

  const agentMap = new Map<string, AgentConfig>();

  // User-scoped sources (global + config repo)
  if (scope === "user" || scope === "both") {
    // Global: ~/.pi/agent/agents/
    for (const agent of loadAgentsFromDir(globalDir, "global")) {
      agentMap.set(agent.name, agent);
    }

    // Config repo: pi/agents/
    if (configAgentsDir) {
      for (const agent of loadAgentsFromDir(configAgentsDir, "config")) {
        agentMap.set(agent.name, agent);
      }
    }
  }

  // Project-scoped sources
  if (scope === "project" || scope === "both") {
    // .agents/agents/ (lower priority among project sources)
    if (dotAgentsDir) {
      for (const agent of loadAgentsFromDir(dotAgentsDir, "project")) {
        agentMap.set(agent.name, agent);
      }
    }

    // .pi/agents/ (highest priority)
    if (projectAgentsDir) {
      for (const agent of loadAgentsFromDir(projectAgentsDir, "project")) {
        agentMap.set(agent.name, agent);
      }
    }
  }

  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/**
 * Full discovery — all locations, no scope filter.
 * Used for session persona commands (/agent:name, --agent).
 */
export function discoverAgents(cwd: string): AgentConfig[] {
  return discoverAgentsScoped(cwd, "both").agents;
}

// ── Formatting ─────────────────────────────────────────────────

export function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "none";
  return agents.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; ");
}
