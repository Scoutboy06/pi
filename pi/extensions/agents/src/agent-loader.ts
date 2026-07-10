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
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "project" | "config" | "global";
  filePath: string;
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

// ── Main discovery ─────────────────────────────────────────────

export function discoverAgents(cwd: string): AgentConfig[] {
  const agentMap = new Map<string, AgentConfig>();

  // Low to high priority — later entries override earlier ones

  // 4. Global: ~/.pi/agent/agents/
  const globalDir = path.join(getAgentDir(), "agents");
  for (const agent of loadAgentsFromDir(globalDir, "global")) {
    agentMap.set(agent.name, agent);
  }

  // 3. Config repo: pi/agents/ (walk up from cwd)
  const configAgentsDir = findUp(cwd, "pi/agents");
  if (configAgentsDir) {
    for (const agent of loadAgentsFromDir(configAgentsDir, "config")) {
      agentMap.set(agent.name, agent);
    }
  }

  // 2. .agents/agents/ (cwd + ancestors)
  const dotAgentsDir = findUp(cwd, ".agents/agents");
  if (dotAgentsDir) {
    for (const agent of loadAgentsFromDir(dotAgentsDir, "project")) {
      agentMap.set(agent.name, agent);
    }
  }

  // 1. .pi/agents/ (cwd + ancestors) — highest priority
  const dotPiAgentsDir = findUp(cwd, `${CONFIG_DIR_NAME}/agents`);
  if (dotPiAgentsDir) {
    for (const agent of loadAgentsFromDir(dotPiAgentsDir, "project")) {
      agentMap.set(agent.name, agent);
    }
  }

  return Array.from(agentMap.values());
}

// ── Formatting ─────────────────────────────────────────────────

export function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "none";
  return agents.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; ");
}
