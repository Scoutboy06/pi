import { describe, it, expect, beforeAll } from "bun:test";
import { MarkdownAgentLoader } from "../agent-loader";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "agents");

describe("MarkdownAgentLoader", () => {
  let loader: MarkdownAgentLoader;

  beforeAll(() => {
    loader = new MarkdownAgentLoader(
      (path: string) => readFile(path, "utf-8"),
      (path: string) => readdir(path),
    );
  });

  it("loads agents from a directory of markdown files", async () => {
    const result = await loader.load(FIXTURES_DIR);

    expect(result.errors).toEqual([]);
    expect(result.definitions.length).toBe(2);

    const names = result.definitions.map((d) => d.name).sort();
    expect(names).toEqual(["code-reviewer", "simple-agent"]);
  });

  it("parses the code-reviewer agent correctly", async () => {
    const result = await loader.load(FIXTURES_DIR);
    const reviewer = result.definitions.find((d) => d.name === "code-reviewer")!;

    expect(reviewer).toBeDefined();
    expect(reviewer.name).toBe("code-reviewer");
    expect(reviewer.description).toContain("Expert code reviewer");
    expect(reviewer.model).toBe("sonnet");
    expect(reviewer.tools).toEqual(["read", "grep", "glob", "bash"]);
    expect(reviewer.maxTurns).toBe(20);
    expect(reviewer.systemPrompt).toContain("You are a senior code reviewer");
    expect(reviewer.systemPrompt).toContain("git diff");
  });

  it("parses the simple-agent correctly", async () => {
    const result = await loader.load(FIXTURES_DIR);
    const simple = result.definitions.find((d) => d.name === "simple-agent")!;

    expect(simple).toBeDefined();
    expect(simple.name).toBe("simple-agent");
    expect(simple.description).toBe("A simple agent for testing purposes. Use when you need basic help.");
    expect(simple.model).toBe("inherit");
    expect(simple.tools).toBeUndefined();
    expect(simple.disallowedTools).toBeUndefined();
    expect(simple.maxTurns).toBeUndefined();
    expect(simple.systemPrompt).toBe("You are a simple assistant. Be helpful and concise.");
  });

  it("reports errors for missing required fields", async () => {
    const mockLoader = new MarkdownAgentLoader(
      async () => `---\ndescription: I have no name\n---\nBody.`,
      async () => ["bad-agent.md"],
    );

    const result = await mockLoader.load("/fake");
    expect(result.definitions).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toContain("name");
  });

  it("reports errors when directory cannot be read", async () => {
    const mockLoader = new MarkdownAgentLoader(
      async () => "",
      async () => {
        throw new Error("ENOENT");
      },
    );

    const result = await mockLoader.load("/nonexistent");
    expect(result.definitions).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toContain("Failed to read directory");
  });

  describe("parseAgentFile with invalid content", () => {
    it("throws on missing name", () => {
      expect(() =>
        loader.parseAgentFile("test.md", `---\ndescription: desc\n---\nBody.`),
      ).toThrow(/name/);
    });

    it("throws on missing description", () => {
      expect(() =>
        loader.parseAgentFile("test.md", `---\nname: test\n---\nBody.`),
      ).toThrow(/description/);
    });

    it("works with minimal valid frontmatter", () => {
      const def = loader.parseAgentFile(
        "test.md",
        `---\nname: minimal\ndescription: A minimal agent\n---\nBe concise.`,
      );

      expect(def.name).toBe("minimal");
      expect(def.description).toBe("A minimal agent");
      expect(def.systemPrompt).toBe("Be concise.");
      expect(def.model).toBe("inherit");
    });
  });
});