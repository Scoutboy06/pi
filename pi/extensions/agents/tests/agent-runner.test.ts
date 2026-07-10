import { describe, it, expect } from "bun:test";
import { AgentRunner } from "../src/agent-runner";

// ── Tests ──────────────────────────────────────────────────────

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
