/**
 * Result of resolving a model reference from an agent definition.
 */
export type ResolvedModel =
  | { type: "concrete"; provider: string; model: string }
  | { type: "inherit" }
  | { type: "error"; message: string };

/**
 * Interface for resolving agent model references to concrete provider/model pairs.
 */
export interface ModelAliasResolver {
  resolve(alias: string): ResolvedModel;
}

/**
 * Resolves model aliases using a JSON map of alias → provider/model strings.
 *
 * Aliases are defined in a JSON file like:
 * ```json
 * { "sonnet": "openrouter/anthropic/claude-sonnet-4-20250514" }
 * ```
 *
 * The resolver supports:
 * - Short aliases (looked up in the alias map)
 * - Full `provider/model` syntax (passed through)
 * - `inherit` (returns the inherit sentinel)
 */
export class AgentModelResolver implements ModelAliasResolver {
  private readonly aliases: Map<string, string>;

  constructor(aliasMap: Record<string, string>) {
    this.aliases = new Map(Object.entries(aliasMap));
  }

  resolve(modelRef: string): ResolvedModel {
    if (modelRef === "inherit" || modelRef === "") {
      return { type: "inherit" };
    }

    // Check if it looks like a full provider/model reference
    if (modelRef.includes("/")) {
      const [provider, ...modelParts] = modelRef.split("/");
      const model = modelParts.join("/");
      if (!provider || !model) {
        return { type: "error", message: `Invalid provider/model format: "${modelRef}"` };
      }
      return { type: "concrete", provider, model };
    }

    // Look up alias
    const resolved = this.aliases.get(modelRef);
    if (!resolved) {
      return {
        type: "error",
        message: `Unknown model alias: "${modelRef}". Available aliases: ${[...this.aliases.keys()].join(", ")}`,
      };
    }

    // Parse alias value as provider/model
    const slashIndex = resolved.indexOf("/");
    if (slashIndex === -1) {
      return {
        type: "error",
        message: `Invalid alias value for "${modelRef}": "${resolved}" (expected provider/model)`,
      };
    }

    const provider = resolved.slice(0, slashIndex);
    const model = resolved.slice(slashIndex + 1);
    return { type: "concrete", provider, model };
  }

  /** Create a resolver from a JSON string. */
  static fromJson(json: string): AgentModelResolver {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        "Model aliases must be a JSON object mapping alias names to provider/model strings",
      );
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        throw new Error(`Model alias "${key}" must be a string, got ${typeof value}`);
      }
    }
    return new AgentModelResolver(parsed as Record<string, string>);
  }

  /** List all known aliases. */
  getAliases(): string[] {
    return [...this.aliases.keys()];
  }
}
