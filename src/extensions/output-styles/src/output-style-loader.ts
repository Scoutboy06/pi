import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  type OutputStyle,
  type OutputStyleDiagnostic,
  type OutputStyleSource,
  normalizeStyleName,
} from "./output-style.js";

interface OutputStyleFrontmatter {
  [key: string]: unknown;
  name?: unknown;
  description?: unknown;
  "keep-coding-instructions"?: unknown;
}

export interface LoadOutputStylesOptions {
  cwd: string;
  agentDir: string;
  includeProject: boolean;
}

export interface LoadOutputStylesResult {
  styles: OutputStyle[];
  diagnostics: OutputStyleDiagnostic[];
}

const BUILTIN_STYLES: OutputStyle[] = [
  {
    name: "Default",
    description: "Pi's standard software-engineering behavior",
    keepCodingInstructions: true,
    instructions: "",
    source: "builtin",
  },
  {
    name: "Proactive",
    description: "Act immediately and make reasonable assumptions",
    keepCodingInstructions: true,
    instructions: `Execute immediately and prefer action over planning.
Make reasonable assumptions for routine decisions instead of pausing to ask.
Ask only when a decision is genuinely blocking, risky, destructive, or cannot be inferred safely.
Keep the user's permission and safety constraints unchanged.`,
    source: "builtin",
  },
  {
    name: "Concise",
    description: "Lead with the result and keep responses short",
    keepCodingInstructions: true,
    instructions: `Lead with the result. Skip preamble, narration, and unnecessary recaps.
Keep responses short by default while doing the underlying work thoroughly.
When the user asks for explanation or detail, answer fully.
Never abbreviate error reports, security warnings, or confirmations for destructive actions.`,
    source: "builtin",
  },
  {
    name: "Explanatory",
    description: "Explain implementation choices and codebase patterns",
    keepCodingInstructions: true,
    instructions: `Complete the software-engineering task while teaching the user about the implementation.
Add brief, relevant "Insight" callouts for important implementation choices, tradeoffs, and codebase patterns.
Keep insights tied to the work at hand; do not let them replace or obstruct progress.`,
    source: "builtin",
  },
  {
    name: "Learning",
    description: "Collaborative learn-by-doing with strategic user contributions",
    keepCodingInstructions: true,
    instructions: `Use a collaborative, learn-by-doing approach.
Explain important implementation choices and codebase patterns with concise "Insight" callouts.
When appropriate, ask the user to implement a small, strategic, non-critical piece themselves.
Mark that location with TODO(human), explain the goal and constraints, and wait for their contribution before completing it.
Do not delegate security-sensitive, destructive, repetitive, or time-critical work to the user.`,
    source: "builtin",
  },
];

export class OutputStyleLoader {
  load({ cwd, agentDir, includeProject }: LoadOutputStylesOptions): LoadOutputStylesResult {
    const stylesByName = new Map<string, OutputStyle>();
    const diagnostics: OutputStyleDiagnostic[] = [];

    for (const style of BUILTIN_STYLES) this.add(stylesByName, style);

    this.loadDirectory(join(agentDir, "output-styles"), "user", stylesByName, diagnostics);

    if (includeProject) {
      for (const directory of this.projectDirectories(cwd)) {
        for (const configDirectory of [".agents", CONFIG_DIR_NAME]) {
          this.loadDirectory(
            join(directory, configDirectory, "output-styles"),
            "project",
            stylesByName,
            diagnostics,
          );
        }
      }
    }

    return { styles: [...stylesByName.values()], diagnostics };
  }

  private loadDirectory(
    directory: string,
    source: OutputStyleSource,
    stylesByName: Map<string, OutputStyle>,
    diagnostics: OutputStyleDiagnostic[],
  ): void {
    if (!existsSync(directory)) return;

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
    } catch (error) {
      diagnostics.push({ path: directory, message: this.errorMessage(error) });
      return;
    }

    for (const entry of entries) {
      if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;

      const filePath = join(directory, entry.name);
      const style = this.loadFile(filePath, source, diagnostics);
      if (style) this.add(stylesByName, style);
    }
  }

  private loadFile(
    filePath: string,
    source: OutputStyleSource,
    diagnostics: OutputStyleDiagnostic[],
  ): OutputStyle | undefined {
    try {
      if (!statSync(filePath).isFile()) return undefined;

      const content = readFileSync(filePath, "utf8");
      const { frontmatter, body } = parseFrontmatter<OutputStyleFrontmatter>(content);
      const fallbackName = basename(filePath, extname(filePath));
      const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : fallbackName;

      if (!name) {
        diagnostics.push({ path: filePath, message: "output style name cannot be empty" });
        return undefined;
      }
      if (!body.trim()) {
        diagnostics.push({ path: filePath, message: "output style instructions cannot be empty" });
        return undefined;
      }
      if (
        frontmatter["keep-coding-instructions"] !== undefined &&
        typeof frontmatter["keep-coding-instructions"] !== "boolean"
      ) {
        diagnostics.push({
          path: filePath,
          message: "keep-coding-instructions must be true or false",
        });
        return undefined;
      }

      const description =
        typeof frontmatter.description === "string" && frontmatter.description.trim()
          ? frontmatter.description.trim()
          : `Custom output style from ${basename(filePath)}`;

      return {
        name,
        description,
        keepCodingInstructions: frontmatter["keep-coding-instructions"] === true,
        instructions: body.trim(),
        source,
        filePath,
      };
    } catch (error) {
      diagnostics.push({ path: filePath, message: this.errorMessage(error) });
      return undefined;
    }
  }

  private projectDirectories(cwd: string): string[] {
    const resolvedCwd = resolve(cwd);
    const repositoryRoot = this.findRepositoryRoot(resolvedCwd);
    const directories: string[] = [];
    let directory = resolvedCwd;

    while (true) {
      directories.unshift(directory);
      if (directory === repositoryRoot) return directories;
      directory = dirname(directory);
    }
  }

  private findRepositoryRoot(cwd: string): string {
    let directory = cwd;

    while (true) {
      if (existsSync(join(directory, ".git"))) return directory;
      const parent = dirname(directory);
      if (parent === directory) return cwd;
      directory = parent;
    }
  }

  private add(stylesByName: Map<string, OutputStyle>, style: OutputStyle): void {
    stylesByName.set(normalizeStyleName(style.name), style);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "failed to load output style";
  }
}
