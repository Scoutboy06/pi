import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatContextFiles, InstructionFileDiscovery } from "../src/context-files.js";

const temporaryDirectories: string[] = [];

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-instruction-files-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeInstruction(directory: string, filename: string, content: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("InstructionFileDiscovery", () => {
  it("discovers instruction files from root to cwd", () => {
    const root = createDirectory();
    const projectDirectory = join(root, "project");
    const nestedDirectory = join(projectDirectory, "packages", "app");
    const discovery = new InstructionFileDiscovery();

    writeInstruction(projectDirectory, "AGENTS.md", "project");
    writeInstruction(nestedDirectory, "AGENTS.local.md", "nested");

    expect(discovery.discover({ cwd: nestedDirectory }).map((file) => file.content)).toEqual([
      "project",
      "nested",
    ]);
  });

  it("prefers AGENTS files over CLAUDE files in the same directory", () => {
    const root = createDirectory();
    const discovery = new InstructionFileDiscovery();

    writeInstruction(root, "AGENTS.md", "agents");
    writeInstruction(root, "CLAUDE.md", "claude");
    writeInstruction(root, "AGENTS.local.md", "agents local");
    writeInstruction(root, "CLAUDE.local.md", "claude local");

    expect(discovery.discover({ cwd: root }).map((file) => file.content)).toEqual([
      "agents",
      "agents local",
    ]);
  });

  it("uses CLAUDE files when AGENTS counterparts are absent", () => {
    const root = createDirectory();
    const discovery = new InstructionFileDiscovery();

    writeInstruction(root, "CLAUDE.md", "claude");
    writeInstruction(root, "CLAUDE.local.md", "claude local");

    expect(discovery.discover({ cwd: root }).map((file) => file.content)).toEqual([
      "claude",
      "claude local",
    ]);
  });

  it("skips paths already loaded by Pi", () => {
    const root = createDirectory();
    const discovery = new InstructionFileDiscovery();
    const agentsPath = writeInstruction(root, "AGENTS.md", "agents");
    writeInstruction(root, "CLAUDE.local.md", "claude local");

    expect(
      discovery.discover({ cwd: root, excludePaths: [agentsPath] }).map((file) => file.content),
    ).toEqual(["claude local"]);
  });

  it("skips byte-identical instruction content", () => {
    const root = createDirectory();
    const nestedDirectory = join(root, "nested");
    const discovery = new InstructionFileDiscovery();

    writeInstruction(root, "AGENTS.md", "shared\n");
    writeInstruction(nestedDirectory, "CLAUDE.md", "shared\n");
    writeInstruction(nestedDirectory, "CLAUDE.local.md", "local");

    expect(discovery.discover({ cwd: nestedDirectory }).map((file) => file.content)).toEqual([
      "shared\n",
      "local",
    ]);
  });

  it("formats discovered files as an instruction block", () => {
    expect(formatContextFiles([{ path: "/project/CLAUDE.md", content: "Follow rules.\n" }])).toBe(
      '<instruction_context_files>\nThe instruction-files extension discovered additional project instructions. More specific files appear later.\n<context_file path="/project/CLAUDE.md">\nFollow rules.\n</context_file>\n</instruction_context_files>',
    );
  });
});
