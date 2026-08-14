import { describe, expect, it } from "bun:test";
import type { AgentConfig } from "../src/agent-loader.js";
import { selectRequestedProjectAgents } from "../src/agent-tool.js";

function createAgent(name: string, source: AgentConfig["source"]): AgentConfig {
  return {
    name,
    description: `${name} description`,
    systemPrompt: `${name} prompt`,
    source,
    filePath: `/agents/${name}.md`,
  };
}

describe("selectRequestedProjectAgents", () => {
  it("selects project agents but excludes bundled config agents", () => {
    const agents = [
      createAgent("explorer", "config"),
      createAgent("reviewer", "project"),
      createAgent("global-worker", "global"),
    ];

    const selected = selectRequestedProjectAgents(
      new Set(["explorer", "reviewer", "global-worker"]),
      agents,
    );

    expect(selected.map((agent) => agent.name)).toEqual(["reviewer"]);
  });
});
