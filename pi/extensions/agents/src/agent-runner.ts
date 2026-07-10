/**
 * AgentRunner — Applies an agent persona to a session or spawns a sub-agent.
 *
 * Two modes:
 *   - applyToSession: replaces current session's system prompt, tools, and model
 *     (used by /agent:<name> slash command)
 *   - runAsSubagent: spawns an isolated pi process with the agent persona
 *     (used by the agent() tool)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agent-loader";

// ── Session persona application ────────────────────────────────

/**
 * Applies an agent persona to the current session.
 * Stores the active agent so before_agent_start can apply overrides.
 */
export class AgentRunner {
  private activeAgent: AgentConfig | null = null;
  private originalTools: string[] | null = null;
  private originalModel: { provider: string; id: string } | null = null;

  /** Whether a custom agent persona is currently active. */
  isActive(): boolean {
    return this.activeAgent !== null;
  }

  /** Get the currently active agent, if any. */
  getActive(): AgentConfig | null {
    return this.activeAgent;
  }

  /**
   * Apply an agent persona. Switches model (if specified) and restricts tools.
   * The system prompt override is applied in before_agent_start.
   */
  async apply(agent: AgentConfig, pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    // Save original state before first application
    if (!this.activeAgent) {
      this.originalTools = pi.getActiveTools();
      const model = ctx.model;
      if (model) {
        this.originalModel = { provider: model.provider, id: model.id };
      }
    }

    this.activeAgent = agent;

    // Switch model if specified
    if (agent.model) {
      const modelPattern = agent.model;
      // Try to find the model; modelPattern could be "provider/id" or just "id"
      const slashIdx = modelPattern.indexOf("/");
      const provider = slashIdx >= 0 ? modelPattern.slice(0, slashIdx) : undefined;
      const modelId = slashIdx >= 0 ? modelPattern.slice(slashIdx + 1) : modelPattern;

      const allModels = ctx.modelRegistry.getAll();
      const found = allModels.find(
        (m) =>
          (provider ? m.provider === provider : true) &&
          (m.id === modelId || m.id.includes(modelId)),
      );

      if (found) {
        await pi.setModel(found);
      } else {
        ctx.ui.notify(
          `Agent "${agent.name}" wants model "${modelPattern}" but it's not available. Keeping current model.`,
          "warning",
        );
      }
    }

    // Restrict tools if specified
    if (agent.tools && agent.tools.length > 0) {
      pi.setActiveTools(agent.tools);
    } else {
      // If no tools specified, use all default tools (but restore to original if we had an agent before)
      if (this.originalTools) {
        pi.setActiveTools(this.originalTools);
      }
    }
  }

  /** Clear the active agent persona and restore original model/tools. */
  async clear(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    this.activeAgent = null;

    // Restore tools
    if (this.originalTools) {
      pi.setActiveTools(this.originalTools);
      this.originalTools = null;
    }

    // Restore model
    if (this.originalModel) {
      const found = ctx.modelRegistry.find(this.originalModel.provider, this.originalModel.id);
      if (found) {
        await pi.setModel(found);
      }
      this.originalModel = null;
    }
  }

  /**
   * Get the system prompt for the active agent (raw body text).
   * Returns empty string if no agent is active (use pi's default).
   */
  getSystemPrompt(): string {
    return this.activeAgent?.systemPrompt ?? "";
  }
}

// ── Sub-agent execution ────────────────────────────────────────

export interface SubagentResult {
  output: string;
  exitCode: number;
  stderr: string;
}

/**
 * Spawn a sub-agent as a separate `pi` process.
 * Uses JSON mode for structured output capture.
 */
export async function runSubagent(
  agent: AgentConfig,
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<SubagentResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];

  if (agent.model) {
    args.push("--model", agent.model);
  }

  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }

  // Write system prompt to temp file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-"));
  const promptFile = path.join(tmpDir, `prompt-${agent.name}.md`);
  fs.writeFileSync(promptFile, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
  args.push("--append-system-prompt", promptFile);

  args.push(`Task: ${task}`);

  // Find pi binary
  const piCommand = getPiCommand();

  return new Promise<SubagentResult>((resolve) => {
    const proc = spawn(piCommand.command, [...piCommand.args, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      // Parse JSON events, collect final text
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message?.role === "assistant") {
            for (const part of event.message.content) {
              if (part.type === "text") {
                output += part.text;
              }
            }
          }
        } catch {
          // Non-JSON lines ignored
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      // Cleanup temp files
      try {
        fs.unlinkSync(promptFile);
        fs.rmdirSync(tmpDir);
      } catch {
        // ignore
      }

      resolve({
        output: output.trim(),
        exitCode: code ?? 0,
        stderr,
      });
    });

    proc.on("error", () => {
      try {
        fs.unlinkSync(promptFile);
        fs.rmdirSync(tmpDir);
      } catch {
        // ignore
      }

      resolve({
        output: "",
        exitCode: 1,
        stderr,
      });
    });

    if (signal) {
      const killProc = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) {
        killProc();
      } else {
        signal.addEventListener("abort", killProc, { once: true });
      }
    }
  });
}

/** Find the pi binary to spawn for sub-agents. */
function getPiCommand(): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");

  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);

  if (!isGenericRuntime) {
    return { command: process.execPath, args: [] };
  }

  return { command: "pi", args: [] };
}
