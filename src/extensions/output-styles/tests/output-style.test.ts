import { describe, expect, test } from "bun:test";
import { type OutputStyle, OutputStyleRegistry } from "../src/output-style.js";

function createStyle(overrides: Partial<OutputStyle> = {}): OutputStyle {
  return {
    name: "Default",
    description: "Default",
    keepCodingInstructions: true,
    instructions: "",
    source: "builtin",
    ...overrides,
  };
}

describe("OutputStyleRegistry", () => {
  test("resolves and activates names case-insensitively", () => {
    const registry = new OutputStyleRegistry([
      createStyle(),
      createStyle({ name: "Diagrams First", instructions: "Draw.", source: "user" }),
    ]);

    expect(registry.activate("diagrams first")?.name).toBe("Diagrams First");
    expect(registry.getActive().name).toBe("Diagrams First");
  });

  test("appends styles that keep coding instructions", () => {
    const registry = new OutputStyleRegistry([
      createStyle(),
      createStyle({ name: "Concise", instructions: "Be brief." }),
    ]);
    registry.activate("Concise");

    const prompt = registry.buildSystemPrompt("BASE CODING PROMPT", "/project");

    expect(prompt).toStartWith("BASE CODING PROMPT");
    expect(prompt).toContain('<output_style name="Concise">');
    expect(prompt).toContain("Be brief.");
  });

  test("replaces coding instructions when the style opts out", () => {
    const registry = new OutputStyleRegistry([
      createStyle(),
      createStyle({
        name: "Writer",
        keepCodingInstructions: false,
        instructions: "Write polished prose.",
        source: "user",
      }),
    ]);
    registry.activate("Writer");

    const prompt = registry.buildSystemPrompt(
      "BASE CODING PROMPT",
      "/project",
      "\n\n<project_context>Keep project rules.</project_context>",
    );

    expect(prompt).not.toContain("BASE CODING PROMPT");
    expect(prompt).toContain("Current working directory: /project");
    expect(prompt).toContain("Write polished prose.");
    expect(prompt).toContain("<project_context>Keep project rules.</project_context>");
  });

  test("leaves the built-in default system prompt unchanged", () => {
    const registry = new OutputStyleRegistry([createStyle()]);

    expect(registry.buildSystemPrompt("BASE", "/project")).toBe("BASE");
  });

  test("applies a custom style that overrides Default", () => {
    const registry = new OutputStyleRegistry([
      createStyle({
        keepCodingInstructions: false,
        instructions: "Act as an editor.",
        source: "user",
      }),
    ]);

    expect(registry.buildSystemPrompt("BASE", "/project")).toContain("Act as an editor.");
  });

  test("keeps the active style when definitions reload", () => {
    const registry = new OutputStyleRegistry([
      createStyle(),
      createStyle({ name: "Review", instructions: "old", source: "user" }),
    ]);
    registry.activate("Review");

    registry.replace([
      createStyle(),
      createStyle({ name: "Review", instructions: "new", source: "project" }),
    ]);

    expect(registry.getActive()).toMatchObject({ instructions: "new", source: "project" });
  });
});
