import { describe, it, expect } from "bun:test";
import type { AgentConfig } from "../src/agent-loader.js";
import { AgentRunner, withModelOverride } from "../src/agent-runner.js";

// ── Tests ──────────────────────────────────────────────────────

describe("withModelOverride", () => {
  const agent: AgentConfig = {
    name: "worker",
    description: "Works",
    model: "provider/default",
    systemPrompt: "Work carefully",
    source: "config",
    filePath: "/agents/worker.md",
  };

  it("uses an invocation model without mutating the agent definition", () => {
    const invokedAgent = withModelOverride(agent, "openai-codex/gpt-5.6-luna");

    expect(invokedAgent.model).toBe("openai-codex/gpt-5.6-luna");
    expect(agent.model).toBe("provider/default");
  });

  it("keeps the definition model when no invocation override is supplied", () => {
    expect(withModelOverride(agent)).toBe(agent);
  });
});

describe("AgentRunner", () => {
  it("starts with no active agent", () => {
    const runner = new AgentRunner();
    expect(runner.isActive()).toBe(false);
    expect(runner.getActive()).toBeNull();
    expect(runner.getSystemPrompt()).toBe("");
  });

  it("getSystemPrompt returns empty when no agent active", () => {
    const runner = new AgentRunner();
    expect(runner.getSystemPrompt()).toBe("");
  });
});
