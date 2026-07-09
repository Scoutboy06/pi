/**
 * Parsed frontmatter from a markdown agent file.
 */
export interface AgentFrontmatter {
  name?: string;
  description?: string;
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  initialPrompt?: string;
}

/**
 * Immutable value class representing a fully validated agent definition.
 */
export class AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly tools?: string[];
  readonly disallowedTools?: string[];
  readonly maxTurns?: number;
  readonly initialPrompt?: string;
  readonly systemPrompt: string;

  constructor(params: {
    name: string;
    description: string;
    model?: string;
    tools?: string[];
    disallowedTools?: string[];
    maxTurns?: number;
    initialPrompt?: string;
    systemPrompt: string;
  }) {
    this.name = params.name;
    this.description = params.description;
    this.model = params.model ?? "inherit";
    this.tools = params.tools;
    this.disallowedTools = params.disallowedTools;
    this.maxTurns = params.maxTurns;
    this.initialPrompt = params.initialPrompt;
    this.systemPrompt = params.systemPrompt;
  }

  /** The list of fields that were explicitly defined (not defaulted). */
  get definedFields(): string[] {
    const fields: string[] = ["name", "description", "systemPrompt"];
    if (this.model !== "inherit") fields.push("model");
    if (this.tools !== undefined) fields.push("tools");
    if (this.disallowedTools !== undefined) fields.push("disallowedTools");
    if (this.maxTurns !== undefined) fields.push("maxTurns");
    if (this.initialPrompt !== undefined) fields.push("initialPrompt");
    return fields;
  }

  /** Returns the effective tool set after resolving allowlist/denylist against the parent's tools. */
  resolveTools(parentTools: string[]): string[] {
    if (this.tools) {
      // Allowlist: only tools that exist in parent
      return this.tools.filter((t) => parentTools.includes(t));
    }
    if (this.disallowedTools) {
      // Denylist: remove denied tools from parent
      return parentTools.filter((t) => !this.disallowedTools!.includes(t));
    }
    // No restrictions: inherit all parent tools
    return [...parentTools];
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      model: this.model,
      tools: this.tools,
      disallowedTools: this.disallowedTools,
      maxTurns: this.maxTurns,
      initialPrompt: this.initialPrompt,
      systemPromptLength: this.systemPrompt.length,
    };
  }
}