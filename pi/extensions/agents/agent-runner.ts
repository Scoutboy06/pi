import type { AgentDefinition } from "./agent-definition";
import type { AgentModelResolver } from "./agent-model-resolver";

/**
 * Output from a completed agent run.
 */
export interface AgentRunResult {
  /** The final text output from the agent. */
  text: string;
  /** Number of turns the agent took. */
  turns: number;
  /** Whether the agent hit its maxTurns limit. */
  truncated: boolean;
  /** Any error that occurred during execution. */
  error?: string;
}

/**
 * Dependencies needed to run an agent as a sub-agent.
 * All are abstracted behind interfaces for testability.
 */
export interface AgentRunnerContext {
  /** Resolve a model reference to a concrete model. */
  resolveModel(modelRef: string): { provider: string; model: string } | "inherit";
  /** Create and run a sub-agent session with the given configuration. */
  runSubAgent(config: SubAgentConfig): Promise<AgentRunResult>;
}

/**
 * Configuration for running a sub-agent session.
 */
export interface SubAgentConfig {
  systemPrompt: string;
  task: string;
  model: { provider: string; model: string } | "inherit";
  tools: string[];
  maxTurns?: number;
}

/**
 * Runs an agent definition as a sub-agent with a given task.
 *
 * This class orchestrates the lifecycle:
 * 1. Resolve model reference
 * 2. Build sub-agent config
 * 3. Run the sub-agent via the provided context
 * 4. Return the result
 */
export class AgentRunner {
  constructor(
    private readonly definition: AgentDefinition,
    private readonly modelResolver: AgentModelResolver,
    private readonly parentTools: string[],
  ) {}

  /**
   * Run the agent with the given task.
   */
  async run(task: string, ctx: AgentRunnerContext): Promise<AgentRunResult> {
    // Resolve the model
    const resolved = this.modelResolver.resolve(this.definition.model);
    let model: { provider: string; model: string } | "inherit";

    if (resolved.type === "inherit") {
      model = "inherit";
    } else if (resolved.type === "error") {
      return {
        text: "",
        turns: 0,
        truncated: false,
        error: resolved.message,
      };
    } else {
      model = { provider: resolved.provider, model: resolved.model };
    }

    // Resolve tools
    const tools = this.definition.resolveTools(this.parentTools);

    // Build config
    const config: SubAgentConfig = {
      systemPrompt: this.definition.systemPrompt,
      task,
      model,
      tools,
      maxTurns: this.definition.maxTurns,
    };

    // Run
    return ctx.runSubAgent(config);
  }
}
