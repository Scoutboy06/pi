import { AgentDefinition } from "./agent-definition";
import { parseFrontmatter } from "./frontmatter-parser";

/**
 * Result of loading agent definitions.
 */
export interface LoadResult {
  definitions: AgentDefinition[];
  errors: Array<{ file: string; message: string }>;
}

/**
 * Interface for loading agent definitions from a source.
 */
export interface AgentDefinitionLoader {
  load(baseDir: string): Promise<LoadResult>;
}

/**
 * Loads agent definitions from markdown files in a directory.
 * Each `.md` file should have YAML frontmatter and a markdown body.
 */
export class MarkdownAgentLoader implements AgentDefinitionLoader {
  constructor(
    private readonly readFile: (path: string) => Promise<string>,
    private readonly readDir: (path: string) => Promise<string[]>,
  ) {}

  async load(baseDir: string): Promise<LoadResult> {
    const definitions: AgentDefinition[] = [];
    const errors: Array<{ file: string; message: string }> = [];

    let entries: string[];
    try {
      entries = await this.readDir(baseDir);
    } catch {
      errors.push({ file: baseDir, message: "Failed to read directory" });
      return { definitions, errors };
    }

    const mdFiles = entries.filter((e) => e.endsWith(".md"));

    for (const file of mdFiles) {
      try {
        const fullPath = `${baseDir}/${file}`;
        const content = await this.readFile(fullPath);
        const def = this.parseAgentFile(file, content);
        if (def) {
          definitions.push(def);
        }
      } catch (err) {
        errors.push({
          file,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { definitions, errors };
  }

  /**
   * Parse a single agent markdown file.
   * Throws if required fields are missing or invalid.
   */
  parseAgentFile(_filename: string, content: string): AgentDefinition {
    const { frontmatter, body } = parseFrontmatter(content);

    // Validate required fields
    if (!frontmatter.name || typeof frontmatter.name !== "string") {
      throw new Error(`Missing or invalid "name" field`);
    }
    if (!frontmatter.description || typeof frontmatter.description !== "string") {
      throw new Error(`Missing or invalid "description" field`);
    }

    return new AgentDefinition({
      name: frontmatter.name,
      description: frontmatter.description,
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      tools: Array.isArray(frontmatter.tools)
        ? frontmatter.tools.filter((t): t is string => typeof t === "string")
        : undefined,
      disallowedTools: Array.isArray(frontmatter.disallowedTools)
        ? frontmatter.disallowedTools.filter((t): t is string => typeof t === "string")
        : undefined,
      maxTurns: typeof frontmatter.maxTurns === "number" ? frontmatter.maxTurns : undefined,
      initialPrompt:
        typeof frontmatter.initialPrompt === "string" ? frontmatter.initialPrompt : undefined,
      systemPrompt: body || "",
    });
  }
}
