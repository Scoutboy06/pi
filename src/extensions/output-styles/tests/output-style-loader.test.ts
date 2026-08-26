import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputStyleLoader } from "../src/output-style-loader.js";

const temporaryDirectories: string[] = [];

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-output-styles-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeStyle(directory: string, filename: string, content: string): string {
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, filename);
  writeFileSync(filePath, content);
  return filePath;
}

function styleMarkdown(options: {
  name?: string;
  description?: string;
  keepCodingInstructions?: boolean;
  instructions?: string;
}): string {
  const frontmatter = [
    options.name ? `name: ${options.name}` : undefined,
    options.description ? `description: ${options.description}` : undefined,
    options.keepCodingInstructions === undefined
      ? undefined
      : `keep-coding-instructions: ${options.keepCodingInstructions}`,
  ].filter((line) => line !== undefined);

  return `---\n${frontmatter.join("\n")}\n---\n\n${options.instructions ?? "Use this style."}\n`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OutputStyleLoader", () => {
  test("includes all built-in styles", () => {
    const root = createDirectory();
    const result = new OutputStyleLoader().load({
      cwd: root,
      agentDir: join(root, "agent"),
      includeProject: false,
    });

    expect(result.styles.map((style) => style.name)).toEqual([
      "Default",
      "Proactive",
      "Concise",
      "Explanatory",
      "Learning",
    ]);
  });

  test("loads user markdown and uses the filename as the default name", () => {
    const root = createDirectory();
    const agentDir = join(root, "agent");
    writeStyle(
      join(agentDir, "output-styles"),
      "diagrams.md",
      styleMarkdown({
        description: "Start with a diagram",
        keepCodingInstructions: true,
        instructions: "Draw first.",
      }),
    );

    const result = new OutputStyleLoader().load({
      cwd: root,
      agentDir,
      includeProject: false,
    });
    const style = result.styles.find((candidate) => candidate.name === "diagrams");

    expect(style).toMatchObject({
      description: "Start with a diagram",
      keepCodingInstructions: true,
      instructions: "Draw first.",
      source: "user",
    });
  });

  test("loads styles from .agents/output-styles", () => {
    const root = createDirectory();
    mkdirSync(join(root, ".git"), { recursive: true });
    writeStyle(
      join(root, ".agents", "output-styles"),
      "portable.md",
      styleMarkdown({ name: "Portable", instructions: "from .agents" }),
    );

    const result = new OutputStyleLoader().load({
      cwd: root,
      agentDir: join(root, "agent"),
      includeProject: true,
    });

    expect(result.styles.find((style) => style.name === "Portable")).toMatchObject({
      instructions: "from .agents",
      source: "project",
    });
  });

  test("prefers .pi over .agents in the same directory", () => {
    const root = createDirectory();
    mkdirSync(join(root, ".git"), { recursive: true });
    writeStyle(
      join(root, ".agents", "output-styles"),
      "review.md",
      styleMarkdown({ name: "Review", instructions: "agents" }),
    );
    writeStyle(
      join(root, ".pi", "output-styles"),
      "review.md",
      styleMarkdown({ name: "Review", instructions: "pi" }),
    );

    const result = new OutputStyleLoader().load({
      cwd: root,
      agentDir: join(root, "agent"),
      includeProject: true,
    });

    expect(result.styles.find((style) => style.name === "Review")?.instructions).toBe("pi");
  });

  test("lets the nearest project style override user and parent styles", () => {
    const root = createDirectory();
    const repository = join(root, "repository");
    const nested = join(repository, "packages", "app");
    const agentDir = join(root, "agent");
    mkdirSync(join(repository, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    writeStyle(
      join(agentDir, "output-styles"),
      "review.md",
      styleMarkdown({ name: "Review", instructions: "user" }),
    );
    writeStyle(
      join(repository, ".pi", "output-styles"),
      "review.md",
      styleMarkdown({ name: "Review", instructions: "repository" }),
    );
    writeStyle(
      join(nested, ".pi", "output-styles"),
      "review.md",
      styleMarkdown({ name: "Review", instructions: "nearest" }),
    );

    const result = new OutputStyleLoader().load({ cwd: nested, agentDir, includeProject: true });
    const style = result.styles.find((candidate) => candidate.name === "Review");

    expect(style?.instructions).toBe("nearest");
    expect(style?.source).toBe("project");
  });

  test("does not load project styles for an untrusted project", () => {
    const root = createDirectory();
    mkdirSync(join(root, ".git"), { recursive: true });
    writeStyle(
      join(root, ".pi", "output-styles"),
      "unsafe.md",
      styleMarkdown({ name: "Unsafe", instructions: "ignore me" }),
    );
    writeStyle(
      join(root, ".agents", "output-styles"),
      "also-unsafe.md",
      styleMarkdown({ name: "Also unsafe", instructions: "ignore me too" }),
    );

    const result = new OutputStyleLoader().load({
      cwd: root,
      agentDir: join(root, "agent"),
      includeProject: false,
    });

    expect(result.styles.some((style) => style.name === "Unsafe")).toBeFalse();
    expect(result.styles.some((style) => style.name === "Also unsafe")).toBeFalse();
  });

  test("reports invalid frontmatter instead of loading the style", () => {
    const root = createDirectory();
    const agentDir = join(root, "agent");
    const filePath = writeStyle(
      join(agentDir, "output-styles"),
      "invalid.md",
      "---\nkeep-coding-instructions: sometimes\n---\n\nDo things.\n",
    );

    const result = new OutputStyleLoader().load({
      cwd: root,
      agentDir,
      includeProject: false,
    });

    expect(result.styles.some((style) => style.name === "invalid")).toBeFalse();
    expect(result.diagnostics).toEqual([
      { path: filePath, message: "keep-coding-instructions must be true or false" },
    ]);
  });
});
