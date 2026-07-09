import { describe, it, expect } from "bun:test";
import { AgentDefinition } from "../agent-definition";

describe("AgentDefinition", () => {
  it("constructs with required fields", () => {
    const def = new AgentDefinition({
      name: "test-agent",
      description: "A test agent",
      systemPrompt: "You are a test agent.",
    });

    expect(def.name).toBe("test-agent");
    expect(def.description).toBe("A test agent");
    expect(def.systemPrompt).toBe("You are a test agent.");
    expect(def.model).toBe("inherit"); // default
    expect(def.tools).toBeUndefined();
    expect(def.disallowedTools).toBeUndefined();
    expect(def.maxTurns).toBeUndefined();
    expect(def.initialPrompt).toBeUndefined();
  });

  it("constructs with all optional fields", () => {
    const def = new AgentDefinition({
      name: "full-agent",
      description: "Has everything",
      model: "sonnet",
      tools: ["read", "bash"],
      disallowedTools: undefined,
      maxTurns: 10,
      initialPrompt: "Start here",
      systemPrompt: "You are a full agent.",
    });

    expect(def.name).toBe("full-agent");
    expect(def.model).toBe("sonnet");
    expect(def.tools).toEqual(["read", "bash"]);
    expect(def.maxTurns).toBe(10);
    expect(def.initialPrompt).toBe("Start here");
  });

  describe("definedFields", () => {
    it("lists fields that were explicitly set", () => {
      const minimal = new AgentDefinition({
        name: "min",
        description: "desc",
        systemPrompt: "prompt",
      });
      expect(minimal.definedFields).toContain("name");
      expect(minimal.definedFields).toContain("description");
      expect(minimal.definedFields).toContain("systemPrompt");
      expect(minimal.definedFields).not.toContain("model");
      expect(minimal.definedFields).not.toContain("tools");
    });

    it("includes model when non-default", () => {
      const def = new AgentDefinition({
        name: "a",
        description: "d",
        model: "sonnet",
        systemPrompt: "p",
      });
      expect(def.definedFields).toContain("model");
    });
  });

  describe("resolveTools", () => {
    const parentTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];

    it("returns parent tools when no restrictions", () => {
      const def = new AgentDefinition({
        name: "a",
        description: "d",
        systemPrompt: "p",
      });
      expect(def.resolveTools(parentTools)).toEqual(parentTools);
    });

    it("filters to allowlist when tools is set", () => {
      const def = new AgentDefinition({
        name: "a",
        description: "d",
        tools: ["read", "grep"],
        systemPrompt: "p",
      });
      expect(def.resolveTools(parentTools)).toEqual(["read", "grep"]);
    });

    it("removes denied tools when disallowedTools is set", () => {
      const def = new AgentDefinition({
        name: "a",
        description: "d",
        disallowedTools: ["write", "edit"],
        systemPrompt: "p",
      });
      const result = def.resolveTools(parentTools);
      expect(result).not.toContain("write");
      expect(result).not.toContain("edit");
      expect(result).toContain("read");
      expect(result).toContain("bash");
    });

    it("allows tools not in parent (they just won't be available at runtime)", () => {
      const def = new AgentDefinition({
        name: "a",
        description: "d",
        tools: ["read", "nonexistent"],
        systemPrompt: "p",
      });
      // nonexistent is filtered out because it's not in parent tools
      expect(def.resolveTools(parentTools)).toEqual(["read"]);
    });

    it("empty allowlist means no tools", () => {
      const def = new AgentDefinition({
        name: "a",
        description: "d",
        tools: [],
        systemPrompt: "p",
      });
      expect(def.resolveTools(parentTools)).toEqual([]);
    });
  });

  describe("toJSON", () => {
    it("serializes to a plain object", () => {
      const def = new AgentDefinition({
        name: "test",
        description: "desc",
        model: "haiku",
        tools: ["read"],
        systemPrompt: "prompt",
      });

      const json = def.toJSON();
      expect(json.name).toBe("test");
      expect(json.model).toBe("haiku");
      expect(json.tools).toEqual(["read"]);
      expect(json.systemPromptLength).toBe(6);
    });
  });
});