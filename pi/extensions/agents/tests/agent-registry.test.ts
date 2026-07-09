import { describe, it, expect } from "bun:test";
import { AgentRegistry } from "../agent-registry";
import { AgentDefinition } from "../agent-definition";

function makeDef(name: string, opts?: Partial<{ description: string; tools: string[] }>): AgentDefinition {
  return new AgentDefinition({
    name,
    description: opts?.description ?? `${name} description`,
    tools: opts?.tools,
    systemPrompt: `You are ${name}.`,
  });
}

describe("AgentRegistry", () => {
  it("stores and retrieves agents by name", () => {
    const registry = new AgentRegistry([
      makeDef("reviewer"),
      makeDef("debugger"),
    ]);

    expect(registry.get("reviewer")?.name).toBe("reviewer");
    expect(registry.get("debugger")?.name).toBe("debugger");
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("lists all agents", () => {
    const registry = new AgentRegistry([
      makeDef("a"),
      makeDef("b"),
      makeDef("c"),
    ]);

    expect(registry.list()).toHaveLength(3);
    expect(registry.size).toBe(3);
    expect(registry.names.sort()).toEqual(["a", "b", "c"]);
  });

  it("handles empty registry", () => {
    const registry = new AgentRegistry([]);

    expect(registry.size).toBe(0);
    expect(registry.list()).toEqual([]);
    expect(registry.names).toEqual([]);
    expect(registry.get("anything")).toBeUndefined();
  });

  it("deduplicates by name (last wins)", () => {
    const a1 = makeDef("same", { description: "first" });
    const a2 = makeDef("same", { description: "second" });

    const registry = new AgentRegistry([a1, a2]);
    expect(registry.size).toBe(1);
    expect(registry.get("same")?.description).toBe("second");
  });

  describe("fromLoader", () => {
    it("creates registry from loader result", async () => {
      const mockLoader = {
        async load(_dir: string) {
          return {
            definitions: [makeDef("a"), makeDef("b")],
            errors: [],
          };
        },
      };

      const { registry, errors } = await AgentRegistry.fromLoader(mockLoader, "/fake");
      expect(errors).toEqual([]);
      expect(registry.size).toBe(2);
      expect(registry.get("a")).toBeDefined();
      expect(registry.get("b")).toBeDefined();
    });

    it("returns errors alongside registry", async () => {
      const mockLoader = {
        async load(_dir: string) {
          return {
            definitions: [makeDef("ok")],
            errors: [{ file: "bad.md", message: "parse error" }],
          };
        },
      };

      const { registry, errors } = await AgentRegistry.fromLoader(mockLoader, "/fake");
      expect(errors).toHaveLength(1);
      expect(errors[0].file).toBe("bad.md");
      expect(registry.size).toBe(1);
    });
  });
});