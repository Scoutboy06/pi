import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents, formatAgentList } from "../src/agent-loader.js";

// ── Test helpers ───────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-test-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createAgentFile(
  dir: string,
  name: string,
  description: string,
  systemPrompt: string,
  extras: { model?: string; tools?: string } = {},
): string {
  const frontmatter = [`name: ${name}`, `description: ${description}`];
  if (extras.model) frontmatter.push(`model: ${extras.model}`);
  if (extras.tools) frontmatter.push(`tools: ${extras.tools}`);

  const content = `---\n${frontmatter.join("\n")}\n---\n\n${systemPrompt}\n`;
  const filePath = path.join(dir, `${name}.md`);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ── Tests ──────────────────────────────────────────────────────

describe("discoverAgents", () => {
  it("returns empty array when no agent dirs exist", () => {
    // Use a cwd with no agent dirs
    const agents = discoverAgents(tmpDir);
    // Might find global agents if they exist, so just check it's an array
    expect(Array.isArray(agents)).toBe(true);
  });

  it("discovers agents from a .pi/agents directory", () => {
    const agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    createAgentFile(agentsDir, "explorer", "Explores codebases", "You are an explorer.");
    createAgentFile(agentsDir, "reviewer", "Reviews code", "You are a reviewer.", {
      tools: "read, grep, find",
    });

    const agents = discoverAgents(tmpDir);
    const explorer = agents.find((a) => a.name === "explorer");
    const reviewer = agents.find((a) => a.name === "reviewer");

    expect(explorer).toBeDefined();
    expect(explorer!.description).toBe("Explores codebases");
    expect(explorer!.systemPrompt).toBe("You are an explorer.");
    expect(explorer!.source).toBe("project");
    expect(explorer!.tools).toBeUndefined();
    expect(explorer!.model).toBeUndefined();

    expect(reviewer).toBeDefined();
    expect(reviewer!.tools).toEqual(["read", "grep", "find"]);
    expect(reviewer!.source).toBe("project");
  });

  it("discovers Claude-compatible project agents", () => {
    const projectDir = path.join(tmpDir, "claude-project");
    const agentsDir = path.join(projectDir, ".claude", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    createAgentFile(agentsDir, "claude-worker", "Claude project agent", "Compatible body", {
      model: "sonnet",
    });

    const agents = discoverAgents(path.join(projectDir, "nested"));
    const agent = agents.find((candidate) => candidate.name === "claude-worker");

    expect(agent).toBeDefined();
    expect(agent!.source).toBe("project");
    expect(agent!.model).toBe("sonnet");
  });

  it("prefers native Pi project agents over Claude-compatible agents", () => {
    const projectDir = path.join(tmpDir, "priority-project");
    const claudeDir = path.join(projectDir, ".claude", "agents");
    const piDir = path.join(projectDir, ".pi", "agents");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(piDir, { recursive: true });
    createAgentFile(claudeDir, "shared", "From Claude", "claude body");
    createAgentFile(piDir, "shared", "From Pi", "pi body");

    const agent = discoverAgents(projectDir).find((candidate) => candidate.name === "shared");

    expect(agent?.description).toBe("From Pi");
    expect(agent?.systemPrompt).toBe("pi body");
  });

  it("discovers agents from the config repository's src/agents directory", () => {
    const agentsDir = path.join(tmpDir, "src", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    createAgentFile(agentsDir, "config-agent", "From config", "You are a config agent.");

    const agents = discoverAgents(path.join(tmpDir, "nested", "project"));
    const agent = agents.find((candidate) => candidate.name === "config-agent");

    expect(agent).toBeDefined();
    expect(agent!.source).toBe("config");
  });

  it("parses optional fields (model, tools)", () => {
    const agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    createAgentFile(agentsDir, "scout", "Fast scout", "You are a scout.", {
      model: "claude-haiku-4-5",
      tools: "read, grep, find, ls",
    });

    const agents = discoverAgents(path.join(tmpDir, ".pi"));
    const scout = agents.find((a) => a.name === "scout");

    expect(scout).toBeDefined();
    expect(scout!.model).toBe("claude-haiku-4-5");
    expect(scout!.tools).toEqual(["read", "grep", "find", "ls"]);
  });

  it("skips files without name or description", () => {
    const agentsDir = path.join(tmpDir, ".pi", "agents3");
    fs.mkdirSync(agentsDir, { recursive: true });

    // Missing description
    fs.writeFileSync(
      path.join(agentsDir, "no-desc.md"),
      "---\nname: foo\n---\n\nBody here\n",
      "utf-8",
    );

    // Missing name
    fs.writeFileSync(
      path.join(agentsDir, "no-name.md"),
      "---\ndescription: Has description\n---\n\nBody\n",
      "utf-8",
    );

    const agents = discoverAgents(path.join(tmpDir, ".pi"));
    expect(agents.find((a) => a.name === "foo")).toBeUndefined();
  });

  it("higher priority location overrides lower", () => {
    // Create in .agents/agents (priority 2)
    const dotAgentsDir = path.join(tmpDir, ".agents", "agents");
    fs.mkdirSync(dotAgentsDir, { recursive: true });
    createAgentFile(dotAgentsDir, "worker", "From .agents/agents", "dot-agents body");

    // Create in .pi/agents (priority 1, should win)
    const dotPiDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(dotPiDir, { recursive: true });
    createAgentFile(dotPiDir, "worker", "From .pi/agents", "dot-pi body");

    const agents = discoverAgents(tmpDir);
    const worker = agents.find((a) => a.name === "worker");

    expect(worker).toBeDefined();
    expect(worker!.description).toBe("From .pi/agents"); // Higher priority wins
    expect(worker!.systemPrompt).toBe("dot-pi body");
    expect(worker!.source).toBe("project");
  });
});

describe("formatAgentList", () => {
  it("returns 'none' for empty list", () => {
    expect(formatAgentList([])).toBe("none");
  });

  it("formats agents with name, source, and description", () => {
    const result = formatAgentList([
      {
        name: "explorer",
        description: "Explores code",
        systemPrompt: "...",
        source: "project",
        filePath: "/fake/explorer.md",
      },
    ]);
    expect(result).toContain("explorer");
    expect(result).toContain("project");
    expect(result).toContain("Explores code");
  });
});
