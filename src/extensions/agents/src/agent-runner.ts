/**
 * AgentRunner — Applies an agent persona to a session or spawns a sub-agent.
 *
 * Two modes:
 *   - applyToSession: replaces current session's system prompt, tools, and model
 *     (used by /agent:<name> slash command)
 *   - runAsSubagent: spawns an isolated pi process with the agent persona
 *     (used by the agent() tool)
 *
 * Sub-agent features:
 *   - Single, parallel, and chain execution modes
 *   - Usage statistics tracking (tokens, cost, cache, turns, context)
 *   - Structured error tracking (exitCode, stopReason, errorMessage)
 *   - Tool call tracking from JSON event stream
 *   - Live streaming progress via onUpdate
 *   - Output truncation for large results
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentScope } from "./agent-loader.js";
import { discoverAgentsScoped } from "./agent-loader.js";

// ── Constants ──────────────────────────────────────────────────

const MAX_CONCURRENCY = 4;

// ── Types ──────────────────────────────────────────────────────

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: string;
  task: string;
  exitCode: number;
  messages: Array<Record<string, unknown>>;
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
  backgroundRunId?: string;
}

// ── Helpers ────────────────────────────────────────────────────

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

export function getFinalOutput(messages: Array<Record<string, unknown>>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === "assistant") {
      const content = msg.content as Array<Record<string, unknown>>;
      if (content) {
        for (const part of content) {
          if (part && part.type === "text") return part.text as string;
        }
      }
    }
  }
  return "";
}

export function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

// ── Tool call formatting (for display) ─────────────────────────

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: string, text: string) => string,
): string {
  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "find ") +
        themeFg("accent", pattern) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "grep ") +
        themeFg("accent", `/${pattern}/`) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

export function getDisplayItems(messages: Array<Record<string, unknown>>): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of (msg.content as Array<Record<string, unknown>>) || []) {
        if (part.type === "text") items.push({ type: "text", text: part.text as string });
        else if (part.type === "toolCall")
          items.push({
            type: "toolCall",
            name: part.name as string,
            args: (part.arguments || part.args || {}) as Record<string, unknown>,
          });
      }
    }
  }
  return items;
}

// ── Concurrency limiter ────────────────────────────────────────

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const nextResult: TOut[] = Array.from({ length: items.length });
  let nextIndex = 0;
  const workers = Array.from({ length: limit }).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      const item = items[current];
      if (item !== undefined) {
        nextResult[current] = await fn(item, current);
      }
    }
  });
  await Promise.all(workers);
  return nextResult;
}

// ── Temp file helpers ──────────────────────────────────────────

async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

function cleanupTempFiles(tmpDir: string, tmpFilePath: string): void {
  try {
    fs.unlinkSync(tmpFilePath);
  } catch {
    /* ignore */
  }
  try {
    fs.rmdirSync(tmpDir);
  } catch {
    /* ignore */
  }
}

// ── Pi invocation ──────────────────────────────────────────────

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

// ── Core sub-agent runner ──────────────────────────────────────

export type OnUpdateCallback = (partial: {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails;
}) => void;

function makeEmptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * Run a single sub-agent as an isolated pi process.
 * Streams progress via onUpdate and returns structured results.
 */
export async function runSubagent(
  agent: AgentConfig,
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  step?: number,
): Promise<SingleResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];

  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agent.name,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: makeEmptyUsage(),
  };
  if (agent.model) {
    currentResult.model = agent.model;
  }
  if (step !== undefined) {
    currentResult.step = step;
  }

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: makeDetails([currentResult]),
      });
    }
  };

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(`Task: ${task}`);
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const piCmd = getPiCommand();
      const proc = spawn(piCmd.command, [...piCmd.args, ...args], {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        // Track message_end events for assistant and tool results
        if (event.type === "message_end" && event.message) {
          const msg = event.message as Record<string, unknown>;
          if (msg) {
            currentResult.messages.push(msg);

            if (msg.role === "assistant") {
              currentResult.usage.turns++;
              const usage = msg.usage as Record<string, number> | undefined;
              if (usage) {
                currentResult.usage.input += usage.input || 0;
                currentResult.usage.output += usage.output || 0;
                currentResult.usage.cacheRead += usage.cacheRead || 0;
                currentResult.usage.cacheWrite += usage.cacheWrite || 0;
                const costTotal = (usage.cost as Record<string, number> | undefined)?.total ?? 0;
                currentResult.usage.cost += costTotal;
                currentResult.usage.contextTokens = usage.totalTokens || 0;
              }
              if (!currentResult.model && msg.model) currentResult.model = msg.model as string;
              if (msg.stopReason) currentResult.stopReason = msg.stopReason as string;
              if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage as string;
            }
            emitUpdate();
          }
        }

        if (event.type === "tool_result_end" && event.message) {
          const toolMsg = event.message as Record<string, unknown>;
          if (toolMsg) {
            currentResult.messages.push(toolMsg);
            emitUpdate();
          }
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        resolve(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) {
      currentResult.stopReason = "aborted";
      currentResult.errorMessage = "Subagent was aborted";
    }
    return currentResult;
  } finally {
    if (tmpPromptPath && tmpPromptDir) {
      cleanupTempFiles(tmpPromptDir, tmpPromptPath);
    }
  }
}

// ── Multi-mode runners ─────────────────────────────────────────

/**
 * Run a chain of sub-agents sequentially, passing output via {previous} placeholder.
 */
export async function runChain(
  chain: Array<{ agent: string; task: string; cwd?: string }>,
  cwd: string,
  scope: AgentScope,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  projectAgentsDir: string | null,
): Promise<{ results: SingleResult[]; finalOutput: string; isError: boolean }> {
  const discovery = discoverAgentsScoped(cwd, scope);
  const agents = discovery.agents;
  const makeDetails = (results: SingleResult[]): SubagentDetails => ({
    mode: "chain",
    agentScope: scope,
    projectAgentsDir,
    results,
  });

  const results: SingleResult[] = [];
  let previousOutput = "";

  for (let i = 0; i < chain.length; i++) {
    const chainStep = chain[i];
    if (!chainStep) continue;
    const taskWithContext = chainStep.task.replace(/\{previous\}/g, previousOutput);

    // Find agent
    const agent = agents.find((a: AgentConfig) => a.name === chainStep.agent);
    if (!agent) {
      const errResult: SingleResult = {
        agent: chainStep.agent,
        agentSource: "unknown",
        task: taskWithContext,
        exitCode: 1,
        messages: [],
        stderr: `Unknown agent: "${chainStep.agent}"`,
        usage: makeEmptyUsage(),
        step: i + 1,
        stopReason: "error",
        errorMessage: `Unknown agent: "${chainStep.agent}"`,
      };
      results.push(errResult);
      return { results, finalOutput: errResult.errorMessage!, isError: true };
    }

    // Create update callback that includes all previous results
    const chainUpdate: OnUpdateCallback | undefined = onUpdate
      ? (partial) => {
          const currentResult = partial.details.results[0];
          if (currentResult) {
            onUpdate({
              content: partial.content,
              details: makeDetails([...results, currentResult]),
            });
          }
        }
      : undefined;

    const result = await runSubagent(
      agent,
      taskWithContext,
      chainStep.cwd ?? cwd,
      signal,
      chainUpdate,
      makeDetails,
      i + 1,
    );
    results.push(result);

    if (isFailedResult(result)) {
      const errorMsg = getResultOutput(result);
      return {
        results,
        finalOutput: `Chain stopped at step ${i + 1} (${chainStep.agent}): ${errorMsg}`,
        isError: true,
      };
    }
    previousOutput = getFinalOutput(result.messages);
  }

  const lastResult = results[results.length - 1];
  return {
    results,
    finalOutput: (lastResult ? getFinalOutput(lastResult.messages) : "") || "(no output)",
    isError: false,
  };
}

/**
 * Run multiple sub-agents in parallel with concurrency control.
 */
export async function runParallel(
  tasks: Array<{ agent: string; task: string; cwd?: string }>,
  cwd: string,
  scope: AgentScope,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  projectAgentsDir: string | null,
): Promise<{ results: SingleResult[]; isError: boolean }> {
  const discovery = discoverAgentsScoped(cwd, scope);
  const agents = discovery.agents;
  const makeDetails = (results: SingleResult[]): SubagentDetails => ({
    mode: "parallel",
    agentScope: scope,
    projectAgentsDir,
    results,
  });

  // Initialize placeholder results for streaming
  const allResults: SingleResult[] = Array.from({ length: tasks.length });
  for (const i in tasks) {
    const task = tasks[i]!;
    allResults[i] = {
      agent: task.agent,
      agentSource: "unknown",
      task: task.task,
      exitCode: -1, // -1 = still running
      messages: [],
      stderr: "",
      usage: makeEmptyUsage(),
    };
  }

  const emitParallelUpdate = () => {
    if (onUpdate) {
      const running = allResults.filter((r) => r.exitCode === -1).length;
      const done = allResults.filter((r) => r.exitCode !== -1).length;
      onUpdate({
        content: [
          {
            type: "text",
            text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
          },
        ],
        details: makeDetails([...allResults]),
      });
    }
  };

  const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
    const agent = agents.find((a: AgentConfig) => a.name === t.agent);
    if (!agent) {
      const errResult: SingleResult = {
        agent: t.agent,
        agentSource: "unknown",
        task: t.task,
        exitCode: 1,
        messages: [],
        stderr: `Unknown agent: "${t.agent}"`,
        usage: makeEmptyUsage(),
        stopReason: "error",
        errorMessage: `Unknown agent: "${t.agent}"`,
      };
      const idx = index;
      allResults[idx] = errResult;
      emitParallelUpdate();
      return errResult;
    }

    const result = await runSubagent(
      agent,
      t.task,
      t.cwd ?? cwd,
      signal,
      // Per-task update callback
      (partial) => {
        const idx = index;
        const res = partial.details.results[0];
        if (res) {
          allResults[idx] = res;
          emitParallelUpdate();
        }
      },
      makeDetails,
    );
    const idx2 = index;
    allResults[idx2] = result;
    emitParallelUpdate();
    return result;
  });

  return { results, isError: results.some((r) => isFailedResult(r)) };
}

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
      const managedStatusTool = process.env.PI_AGENT_RUN_ID ? ["agent_report_status"] : [];
      pi.setActiveTools([...new Set([...agent.tools, ...managedStatusTool])]);
    } else {
      // If no tools specified, use all default tools
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
