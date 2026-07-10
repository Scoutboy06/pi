import type { AgentDefinition } from "./agent-definition";
import type { AgentDefinitionLoader } from "./agent-loader";

/**
 * Holds all loaded agent definitions and provides lookup by name.
 */
export class AgentRegistry {
  private readonly agents: Map<string, AgentDefinition>;

  constructor(definitions: AgentDefinition[]) {
    this.agents = new Map();
    for (const def of definitions) {
      this.agents.set(def.name, def);
    }
  }

  /** Look up an agent by name. */
  get(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  /** All registered agent definitions. */
  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }

  /** Number of registered agents. */
  get size(): number {
    return this.agents.size;
  }

  /** Agent names. */
  get names(): string[] {
    return [...this.agents.keys()];
  }

  /**
   * Create a registry by loading agents from a loader and directory.
   * Returns both the registry and any load errors.
   */
  static async fromLoader(
    loader: AgentDefinitionLoader,
    baseDir: string,
  ): Promise<{ registry: AgentRegistry; errors: Array<{ file: string; message: string }> }> {
    const { definitions, errors } = await loader.load(baseDir);
    return { registry: new AgentRegistry(definitions), errors };
  }
}
