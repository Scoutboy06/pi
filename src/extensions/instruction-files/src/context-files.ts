import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const INSTRUCTION_BLOCK_TAG = "instruction_context_files";
export const INSTRUCTION_BLOCK_OPEN = `<${INSTRUCTION_BLOCK_TAG}>`;

const INSTRUCTION_FILE_PAIRS = [
  ["AGENTS.md", "CLAUDE.md"],
  ["AGENTS.local.md", "CLAUDE.local.md"],
] as const;

export interface ContextFile {
  path: string;
  content: string;
}

export interface ContextFileDiscoveryOptions {
  cwd: string;
  excludeContents?: Iterable<string>;
  excludePaths?: Iterable<string>;
}

/** Discovers compatible instruction files while preserving directory specificity. */
export class InstructionFileDiscovery {
  discover({
    cwd,
    excludeContents = [],
    excludePaths = [],
  }: ContextFileDiscoveryOptions): ContextFile[] {
    const contextFiles: ContextFile[] = [];
    const seenContents = new Set(excludeContents);
    const seenPaths = new Set(Array.from(excludePaths, (path) => resolve(path)));

    for (const directory of this.directoriesFromRoot(cwd)) {
      for (const [preferredFilename, fallbackFilename] of INSTRUCTION_FILE_PAIRS) {
        const filePath = this.findPreferredFile(directory, preferredFilename, fallbackFilename);
        if (!filePath || seenPaths.has(filePath)) continue;

        const contextFile = this.read(filePath);
        if (!contextFile || seenContents.has(contextFile.content)) continue;

        contextFiles.push(contextFile);
        seenPaths.add(contextFile.path);
        seenContents.add(contextFile.content);
      }
    }

    return contextFiles;
  }

  private directoriesFromRoot(cwd: string): string[] {
    const directories: string[] = [];
    let currentDirectory = resolve(cwd);

    while (true) {
      directories.unshift(currentDirectory);
      const parentDirectory = dirname(currentDirectory);
      if (parentDirectory === currentDirectory) return directories;
      currentDirectory = parentDirectory;
    }
  }

  private findPreferredFile(
    directory: string,
    preferredFilename: string,
    fallbackFilename: string,
  ): string | undefined {
    const preferredPath = resolve(join(directory, preferredFilename));
    if (existsSync(preferredPath)) return preferredPath;

    const fallbackPath = resolve(join(directory, fallbackFilename));
    return existsSync(fallbackPath) ? fallbackPath : undefined;
  }

  private read(filePath: string): ContextFile | undefined {
    try {
      return { path: filePath, content: readFileSync(filePath, "utf-8") };
    } catch (error) {
      console.warn(`Warning: Could not read ${filePath}: ${error}`);
      return undefined;
    }
  }
}

export function formatContextFiles(contextFiles: ContextFile[]): string {
  const parts = [
    INSTRUCTION_BLOCK_OPEN,
    "The instruction-files extension discovered additional project instructions. More specific files appear later.",
  ];

  for (const contextFile of contextFiles) {
    parts.push(
      `<context_file path=${JSON.stringify(contextFile.path)}>`,
      contextFile.content.trimEnd(),
      "</context_file>",
    );
  }

  parts.push(`</${INSTRUCTION_BLOCK_TAG}>`);
  return parts.join("\n");
}
