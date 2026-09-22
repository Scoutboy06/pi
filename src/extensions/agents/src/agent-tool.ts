/**
 * Agent Tool — registers the `agent` tool that the LLM can call to
 * delegate work to a sub-agent persona.
 *
 * Modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Rendering uses Container/Markdown/Spacer for rich expanded views.
 */

import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text, type MarkdownTheme } from "@earendil-works/pi-tui";
import { discoverAgentsScoped, type AgentConfig, type AgentScope } from "./agent-loader.js";
import type { AgentRunManager } from "./agent-run-manager.js";
import type { AgentRunRecord } from "./agent-run-registry.js";
import {
  formatUsageStats,
  formatToolCall,
  getDisplayItems,
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  withModelOverride,
  type DisplayItem,
  type SingleResult,
  type SubagentDetails,
} from "./agent-runner.js";

// ── Constants ──────────────────────────────────────────────────

const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024; // 50 KB

function runRecordToResult(
  run: AgentRunRecord,
  agent: AgentConfig,
  task: string,
  step?: number,
): SingleResult {
  const failed =
    run.status === "failed" || run.status === "stopped" || run.initialTurnOutcome !== undefined;
  const messages =
    run.messages ??
    (run.lastAssistantText
      ? [{ role: "assistant", content: [{ type: "text", text: run.lastAssistantText }] }]
      : []);
  return {
    runId: run.id,
    agent: agent.name,
    agentSource: agent.source,
    task,
    exitCode: failed ? 1 : 0,
    messages,
    stderr: run.error ?? "",
    usage: run.usage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: messages.filter((message) => message.role === "assistant").length,
    },
    ...(run.model ? { model: run.model } : agent.model ? { model: agent.model } : {}),
    ...(run.stopReason ? { stopReason: run.stopReason } : {}),
    ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
    ...(failed && !run.stopReason
      ? { stopReason: run.initialTurnOutcome === "aborted" ? "aborted" : "error" }
      : {}),
    ...(failed && !run.errorMessage ? { errorMessage: run.error ?? "Agent run failed" } : {}),
    ...(step === undefined ? {} : { step }),
  };
}

// ── Tool parameter schemas ─────────────────────────────────────

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  model: Type.Optional(
    Type.String({ description: "Model override for this task (provider/model or model ID)" }),
  ),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  model: Type.Optional(
    Type.String({ description: "Model override for this step (provider/model or model ID)" }),
  ),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
  default: "user",
});

const AgentToolParams = Type.Object({
  agent: Type.Optional(
    Type.String({ description: "Name of the agent to invoke (for single mode)" }),
  ),
  task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
  model: Type.Optional(
    Type.String({ description: "Model override for single mode (provider/model or model ID)" }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: "Prompt before running project-local agents. Default: true.",
      default: true,
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the agent process (single mode)" }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: "Run single mode as a durable background RPC session. Default: false.",
      default: false,
    }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), { description: "Workflow-agnostic labels for a background run" }),
  ),
});

// ── Rendering helpers ──────────────────────────────────────────

function renderDisplayItems(
  items: DisplayItem[],
  themeFg: (color: string, text: string) => string,
  expanded: boolean,
  limit?: number,
): string {
  const toShow = limit ? items.slice(-limit) : items;
  const skipped = limit && items.length > limit ? items.length - limit : 0;
  let text = "";
  if (skipped > 0) text += themeFg("muted", `... ${skipped} earlier items\n`);
  for (const item of toShow) {
    if (item.type === "text") {
      const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
      text += `${themeFg("toolOutput", preview)}\n`;
    } else {
      text += `${themeFg("muted", "→ ") + formatToolCall(item.name, item.args, themeFg)}\n`;
    }
  }
  return text.trimEnd();
}

// ── Tool registration ──────────────────────────────────────────

export function selectRequestedProjectAgents(
  requestedAgentNames: Iterable<string>,
  agents: AgentConfig[],
): AgentConfig[] {
  return Array.from(requestedAgentNames)
    .map((name) => agents.find((agent) => agent.name === name))
    .filter((agent): agent is AgentConfig => agent?.source === "project");
}

export function registerAgentTool(pi: ExtensionAPI, runManager: AgentRunManager): void {
  pi.registerTool({
    name: "agent",
    label: "Agent",
    description:
      "Delegate tasks to specialized agent personas with isolated context. " +
      "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder). " +
      "Single mode can run as a durable background RPC session. " +
      'Default scope is "user" (bundled and global agents). Use agentScope: "both" to include project agents. ' +
      "Agents are defined in bundled src/agents/, .pi/agents/, .agents/agents/, .claude/agents/, or ~/.pi/agents/.",
    promptSnippet: "Delegate a task to a specialized agent persona (single, parallel, or chain)",
    promptGuidelines: [
      "Use the agent tool to delegate focused tasks to specialized personas. " +
        "Available agents are listed in the system prompt. Each agent has specific tools and a tailored system prompt. " +
        "For multiple independent tasks, use parallel mode with the tasks array. " +
        "For sequential tasks where each step depends on the previous, use chain mode with the {previous} placeholder.",
      "Only when the user explicitly asks to list, choose, or verify available subagent models, run `pi --list-models [search]`; do not query the model catalog otherwise.",
    ],
    parameters: AgentToolParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? "user";
      const discovery = discoverAgentsScoped(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const confirmProjectAgents = params.confirmProjectAgents ?? true;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          agentScope,
          projectAgentsDir: discovery.projectAgentsDir,
          results,
          runIds: results.flatMap((result) => (result.runId ? [result.runId] : [])),
        });

      // ── Validation ──────────────────────────────────────────

      if (params.background && !hasSingle) {
        return {
          content: [
            { type: "text", text: "Background execution is supported only for single mode." },
          ],
          details: makeDetails("single")([]),
          isError: true,
        };
      }

      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
            },
          ],
          details: makeDetails("single")([]),
        };
      }

      // ── Security confirmation for project agents ────────────

      if (
        (agentScope === "project" || agentScope === "both") &&
        confirmProjectAgents &&
        ctx.hasUI
      ) {
        const requestedAgentNames = new Set<string>();
        if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
        if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
        if (params.agent) requestedAgentNames.add(params.agent);

        const projectAgentsRequested = selectRequestedProjectAgents(requestedAgentNames, agents);

        if (projectAgentsRequested.length > 0) {
          const names = projectAgentsRequested.map((a) => a.name).join(", ");
          const dir = discovery.projectAgentsDir ?? "(unknown)";
          const ok = await ctx.ui.confirm(
            "Run project agents?",
            `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
          );
          if (!ok) {
            const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
            return {
              content: [{ type: "text", text: "Canceled: project agents not approved." }],
              details: makeDetails(mode)([]),
            };
          }
        }
      }

      // ── Chain mode ──────────────────────────────────────────

      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = "";
        let chainError = false;
        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          if (!step) continue;
          const agent = agents.find((candidate) => candidate.name === step.agent);
          const task = step.task.replace(/\{previous\}/g, previousOutput);
          if (signal?.aborted) {
            results.push({
              agent: step.agent,
              agentSource: agent?.source ?? "unknown",
              task,
              exitCode: 1,
              messages: [],
              stderr: "",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 0,
              },
              stopReason: "aborted",
              errorMessage: "Chain step was aborted before it started",
              step: i + 1,
            });
            chainError = true;
            break;
          }
          if (!agent) {
            const errorResult: SingleResult = {
              agent: step.agent,
              agentSource: "unknown",
              task,
              exitCode: 1,
              messages: [],
              stderr: `Unknown agent: "${step.agent}"`,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 0,
              },
              stopReason: "error",
              errorMessage: `Unknown agent: "${step.agent}"`,
              step: i + 1,
            };
            results.push(errorResult);
            chainError = true;
            break;
          }
          const run = await runManager.start(
            withModelOverride(agent, step.model),
            task,
            step.cwd ?? ctx.cwd,
            params.tags ?? [],
            {
              waitForInitialTurn: true,
              signal,
              onUpdate: (updated) => {
                const current = runRecordToResult(updated, agent, task, i + 1);
                onUpdate?.({
                  content: [{ type: "text", text: updated.lastAssistantText ?? "(running...)" }],
                  details: makeDetails("chain")([...results, current]),
                });
              },
            },
          );
          const result = runRecordToResult(run, agent, task, i + 1);
          results.push(result);
          if (isFailedResult(result)) {
            chainError = true;
            break;
          }
          previousOutput = getFinalOutput(result.messages);
        }
        const finalOutput = chainError
          ? `Chain stopped at step ${results.length}: ${getResultOutput(results[results.length - 1]!)}`
          : getFinalOutput(results[results.length - 1]?.messages ?? []) || "(no output)";
        const finalRunId = results[results.length - 1]?.runId;
        return {
          content: [
            { type: "text", text: `${finalRunId ? `Run ${finalRunId}:\n` : ""}${finalOutput}` },
          ],
          details: makeDetails("chain")(results),
          isError: chainError,
        };
      }

      // ── Parallel mode ───────────────────────────────────────

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > 8) {
          return {
            content: [
              {
                type: "text",
                text: `Too many parallel tasks (${params.tasks.length}). Max is 8.`,
              },
            ],
            details: makeDetails("parallel")([]),
          };
        }

        const parallelTasks = params.tasks;
        const allResults: SingleResult[] = parallelTasks.map((task) => ({
          agent: task.agent,
          agentSource: "unknown",
          task: task.task,
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
        }));
        let nextTask = 0;
        const abortedResult = (task: (typeof parallelTasks)[number]): SingleResult => ({
          agent: task.agent,
          agentSource: "unknown",
          task: task.task,
          exitCode: 1,
          messages: [],
          stderr: "",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
          stopReason: "aborted",
          errorMessage: "Task was aborted before it started",
        });
        const workers = Array.from({ length: Math.min(4, parallelTasks.length) }, async () => {
          while (nextTask < parallelTasks.length) {
            const index = nextTask++;
            const task = parallelTasks[index];
            if (!task) continue;
            if (signal?.aborted) {
              allResults[index] = abortedResult(task);
              onUpdate?.({
                content: [{ type: "text", text: "Parallel tasks canceled" }],
                details: makeDetails("parallel")([...allResults]),
              });
              continue;
            }
            const agent = agents.find((candidate) => candidate.name === task.agent);
            if (!agent) {
              allResults[index] = {
                agent: task.agent,
                agentSource: "unknown",
                task: task.task,
                exitCode: 1,
                messages: [],
                stderr: `Unknown agent: "${task.agent}"`,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: 0,
                  contextTokens: 0,
                  turns: 0,
                },
                stopReason: "error",
                errorMessage: `Unknown agent: "${task.agent}"`,
              };
              continue;
            }
            const run = await runManager.start(
              withModelOverride(agent, task.model),
              task.task,
              task.cwd ?? ctx.cwd,
              params.tags ?? [],
              {
                waitForInitialTurn: true,
                signal,
                onUpdate: (updated) => {
                  allResults[index] = runRecordToResult(updated, agent, task.task);
                  onUpdate?.({
                    content: [
                      {
                        type: "text",
                        text: `Parallel: ${allResults.filter((result) => result.exitCode !== -1).length}/${allResults.length} done`,
                      },
                    ],
                    details: makeDetails("parallel")([...allResults]),
                  });
                },
              },
            );
            allResults[index] = runRecordToResult(run, agent, task.task);
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Parallel: ${allResults.filter((result) => result.exitCode !== -1).length}/${allResults.length} done`,
                },
              ],
              details: makeDetails("parallel")([...allResults]),
            });
          }
        });
        await Promise.all(workers);
        // A cancellation can happen while workers are finishing. Do not leave
        // queued placeholders looking successful or perpetually running.
        if (signal?.aborted) {
          for (let i = 0; i < allResults.length; i++) {
            const task = parallelTasks[i];
            if (task && allResults[i]?.exitCode === -1) allResults[i] = abortedResult(task);
          }
        }
        const results = allResults;
        const isError = results.some((result) => isFailedResult(result));

        const successCount = results.filter((r) => !isFailedResult(r)).length;
        const summaries = results.map((r) => {
          const output = getResultOutput(r);
          const status = isFailedResult(r)
            ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
            : "completed";
          // Truncate each task's output for the LLM
          const truncated =
            output.length > PER_TASK_OUTPUT_CAP
              ? output.slice(0, PER_TASK_OUTPUT_CAP) +
                `\n\n[Output truncated: ${output.length - PER_TASK_OUTPUT_CAP} bytes omitted. Full output preserved in tool details.]`
              : output;
          return `### [${r.agent}] ${status} (${r.runId ?? "no run id"})\n\n${truncated}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
            },
          ],
          details: makeDetails("parallel")(results),
          isError,
        };
      }

      // ── Single mode ─────────────────────────────────────────

      if (params.agent && params.task) {
        const agent = agents.find((a) => a.name === params.agent);

        if (!agent) {
          const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
          return {
            content: [
              {
                type: "text",
                text: `Unknown agent: "${params.agent}". Available agents: ${available}.`,
              },
            ],
            details: makeDetails("single")([]),
            isError: true,
          };
        }

        const invokedAgent = withModelOverride(agent, params.model);

        if (params.background) {
          const run = await runManager.start(
            invokedAgent,
            params.task,
            params.cwd ?? ctx.cwd,
            params.tags ?? [],
          );
          return {
            content: [
              {
                type: "text",
                text: `Started background agent ${agent.name}: ${run.id} [${run.status}]`,
              },
            ],
            details: {
              ...makeDetails("single")([]),
              backgroundRunId: run.id,
            },
            isError: run.status === "failed",
          };
        }

        const run = await runManager.start(
          invokedAgent,
          params.task,
          params.cwd ?? ctx.cwd,
          params.tags ?? [],
          {
            waitForInitialTurn: true,
            signal,
            onUpdate: (updated) => {
              const current = runRecordToResult(updated, invokedAgent, params.task!);
              onUpdate?.({
                content: [{ type: "text", text: updated.lastAssistantText ?? "(running...)" }],
                details: makeDetails("single")([current]),
              });
            },
          },
        );
        const result = runRecordToResult(run, invokedAgent, params.task);

        const isError = isFailedResult(result);
        if (isError) {
          const errorMsg = getResultOutput(result);
          return {
            content: [
              {
                type: "text",
                text: `Run ${result.runId}: Agent ${result.stopReason || "failed"}: ${errorMsg}`,
              },
            ],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Run ${result.runId}:\n${getFinalOutput(result.messages) || "(no output)"}`,
            },
          ],
          details: makeDetails("single")([result]),
        };
      }

      // ── Invalid ─────────────────────────────────────────────

      const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
      return {
        content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
        details: makeDetails("single")([]),
      };
    },

    // ── renderCall ────────────────────────────────────────────

    renderCall(args, theme, _context) {
      const scope: AgentScope = (args.agentScope as AgentScope) ?? "user";
      const themeFg = theme.fg.bind(theme);

      // Chain mode
      if (args.chain && Array.isArray(args.chain) && args.chain.length > 0) {
        const chain = args.chain as Array<{ agent: string; task: string; model?: string }>;
        let text =
          themeFg("toolTitle", theme.bold("agent ")) +
          themeFg("accent", `chain (${chain.length} steps)`) +
          themeFg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(chain.length, 3); i++) {
          const step = chain[i];
          if (!step) continue;
          const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
          const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text +=
            "\n  " +
            themeFg("muted", `${i + 1}.`) +
            " " +
            themeFg("accent", step.agent) +
            themeFg("dim", ` ${preview}`) +
            (step.model ? themeFg("muted", ` [${step.model}]`) : "");
        }
        if (chain.length > 3) text += `\n  ${themeFg("muted", `... +${chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }

      // Parallel mode
      if (args.tasks && Array.isArray(args.tasks) && args.tasks.length > 0) {
        const tasks = args.tasks as Array<{ agent: string; task: string; model?: string }>;
        let text =
          themeFg("toolTitle", theme.bold("agent ")) +
          themeFg("accent", `parallel (${tasks.length} tasks)`) +
          themeFg("muted", ` [${scope}]`);
        for (const t of tasks.slice(0, 3)) {
          const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          text +=
            `\n  ${themeFg("accent", t.agent)}${themeFg("dim", ` ${preview}`)}` +
            (t.model ? themeFg("muted", ` [${t.model}]`) : "");
        }
        if (tasks.length > 3) text += `\n  ${themeFg("muted", `... +${tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }

      // Single mode
      const agentName = (args.agent as string) || "...";
      const preview =
        args.task && typeof args.task === "string"
          ? args.task.length > 60
            ? `${args.task.slice(0, 60)}...`
            : args.task
          : "...";
      let text =
        themeFg("toolTitle", theme.bold("agent ")) +
        themeFg("accent", agentName) +
        themeFg("muted", ` [${scope}]`) +
        (args.model ? themeFg("muted", ` [${String(args.model)}]`) : "") +
        (args.background ? themeFg("warning", " background") : "");
      text += `\n  ${themeFg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    // ── renderResult ──────────────────────────────────────────

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as SubagentDetails | undefined;
      const themeFg = theme.fg.bind(theme);
      const styled = (color: string, text: string) => theme.fg(color as ThemeColor, text);
      const markdownTheme: MarkdownTheme = {
        heading: (text: string) => theme.fg("mdHeading", text),
        link: (text: string) => theme.fg("mdLink", text),
        linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
        code: (text: string) => theme.fg("mdCode", text),
        codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
        codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
        quote: (text: string) => theme.fg("mdQuote", text),
        quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
        hr: (text: string) => theme.fg("mdHr", text),
        listBullet: (text: string) => theme.fg("mdListBullet", text),
        bold: (text: string) => theme.bold(text),
        italic: (text: string) => theme.italic(text),
        strikethrough: (text: string) => theme.strikethrough(text),
        underline: (text: string) => theme.underline(text),
      };

      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      // ── Single mode rendering ───────────────────────────────

      if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        if (!r) {
          const text = result.content[0];
          return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
        }
        const isError = isFailedResult(r);
        const icon = isError ? themeFg("error", "✗") : themeFg("success", "✓");
        const displayItems = getDisplayItems(r.messages);
        const finalOutput = getFinalOutput(r.messages);

        if (expanded) {
          const container = new Container();
          let header = `${icon} ${themeFg("toolTitle", theme.bold(r.agent))}${themeFg("muted", ` (${r.agentSource})`)}`;
          if (isError && r.stopReason) header += ` ${themeFg("error", `[${r.stopReason}]`)}`;
          container.addChild(new Text(header, 0, 0));
          if (isError && r.errorMessage)
            container.addChild(new Text(themeFg("error", `Error: ${r.errorMessage}`), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(themeFg("muted", "─── Task ───"), 0, 0));
          container.addChild(new Text(themeFg("dim", r.task), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(themeFg("muted", "─── Output ───"), 0, 0));
          if (displayItems.length === 0 && !finalOutput) {
            container.addChild(new Text(themeFg("muted", "(no output)"), 0, 0));
          } else {
            for (const item of displayItems) {
              if (item.type === "toolCall")
                container.addChild(
                  new Text(
                    themeFg("muted", "→ ") + formatToolCall(item.name, item.args, styled),
                    0,
                    0,
                  ),
                );
            }
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, markdownTheme));
            }
          }
          const usageStr = formatUsageStats(r.usage, r.model);
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(themeFg("dim", usageStr), 0, 0));
          }
          return container;
        }

        // Collapsed single
        let text = `${icon} ${themeFg("toolTitle", theme.bold(r.agent))}${themeFg("muted", ` (${r.agentSource})`)}`;
        if (isError && r.stopReason) text += ` ${themeFg("error", `[${r.stopReason}]`)}`;
        if (isError && r.errorMessage) text += `\n${themeFg("error", `Error: ${r.errorMessage}`)}`;
        else if (displayItems.length === 0) text += `\n${themeFg("muted", "(no output)")}`;
        else {
          text += `\n${renderDisplayItems(displayItems, styled, expanded, COLLAPSED_ITEM_COUNT)}`;
          if (displayItems.length > COLLAPSED_ITEM_COUNT)
            text += `\n${themeFg("muted", "(Ctrl+O to expand)")}`;
        }
        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) text += `\n${themeFg("dim", usageStr)}`;
        return new Text(text, 0, 0);
      }

      // ── Chain mode rendering ────────────────────────────────

      if (details.mode === "chain") {
        const successCount = details.results.filter(
          (r) => r.exitCode === 0 && !isFailedResult(r),
        ).length;
        const icon =
          successCount === details.results.length ? themeFg("success", "✓") : themeFg("error", "✗");

        if (expanded) {
          const container = new Container();
          container.addChild(
            new Text(
              icon +
                " " +
                themeFg("toolTitle", theme.bold("chain ")) +
                themeFg("accent", `${successCount}/${details.results.length} steps`),
              0,
              0,
            ),
          );

          for (const r of details.results) {
            const rIcon = isFailedResult(r) ? themeFg("error", "✗") : themeFg("success", "✓");
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);

            container.addChild(new Spacer(1));
            container.addChild(
              new Text(
                `${themeFg("muted", `─── Step ${r.step}: `) + themeFg("accent", r.agent)} ${rIcon}`,
                0,
                0,
              ),
            );
            container.addChild(new Text(themeFg("muted", "Task: ") + themeFg("dim", r.task), 0, 0));

            // Show tool calls
            for (const item of displayItems) {
              if (item.type === "toolCall") {
                container.addChild(
                  new Text(
                    themeFg("muted", "→ ") + formatToolCall(item.name, item.args, styled),
                    0,
                    0,
                  ),
                );
              }
            }

            // Show final output as markdown
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, markdownTheme));
            }

            const stepUsage = formatUsageStats(r.usage, r.model);
            if (stepUsage) container.addChild(new Text(themeFg("dim", stepUsage), 0, 0));
          }

          // Aggregate usage
          const totalUsage = details.results.reduce(
            (acc, r) => {
              acc.input += r.usage.input;
              acc.output += r.usage.output;
              acc.cacheRead += r.usage.cacheRead;
              acc.cacheWrite += r.usage.cacheWrite;
              acc.cost += r.usage.cost;
              acc.turns += r.usage.turns;
              return acc;
            },
            {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              turns: 0,
              contextTokens: 0,
            },
          );
          const usageStr = formatUsageStats(totalUsage);
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(themeFg("dim", `Total: ${usageStr}`), 0, 0));
          }

          return container;
        }

        // Collapsed chain
        let text =
          icon +
          " " +
          themeFg("toolTitle", theme.bold("chain ")) +
          themeFg("accent", `${successCount}/${details.results.length} steps`);
        for (const r of details.results) {
          const rIcon = isFailedResult(r) ? themeFg("error", "✗") : themeFg("success", "✓");
          const displayItems = getDisplayItems(r.messages);
          text += `\n\n${themeFg("muted", `─── Step ${r.step}: `)}${themeFg("accent", r.agent)} ${rIcon}`;
          if (displayItems.length === 0) text += `\n${themeFg("muted", "(no output)")}`;
          else text += `\n${renderDisplayItems(displayItems, styled, expanded, 5)}`;
        }

        const totalUsage = details.results.reduce(
          (acc, r) => {
            acc.input += r.usage.input;
            acc.output += r.usage.output;
            acc.cacheRead += r.usage.cacheRead;
            acc.cacheWrite += r.usage.cacheWrite;
            acc.cost += r.usage.cost;
            acc.turns += r.usage.turns;
            return acc;
          },
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
        );
        const usageStr = formatUsageStats(totalUsage);
        if (usageStr) text += `\n\n${themeFg("dim", `Total: ${usageStr}`)}`;
        text += `\n${themeFg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      // ── Parallel mode rendering ─────────────────────────────

      if (details.mode === "parallel") {
        const running = details.results.filter((r) => r.exitCode === -1).length;
        const successCount = details.results.filter((r) => !isFailedResult(r)).length;
        const failCount = details.results.filter((r) => isFailedResult(r)).length;
        const isRunning = running > 0;
        const icon = isRunning
          ? themeFg("warning", "⏳")
          : failCount > 0
            ? themeFg("warning", "◐")
            : themeFg("success", "✓");
        const status = isRunning
          ? `${successCount + failCount}/${details.results.length} done, ${running} running`
          : `${successCount}/${details.results.length} tasks`;

        if (expanded && !isRunning) {
          const container = new Container();
          container.addChild(
            new Text(
              `${icon} ${themeFg("toolTitle", theme.bold("parallel "))}${themeFg("accent", status)}`,
              0,
              0,
            ),
          );

          for (const r of details.results) {
            const rIcon = isFailedResult(r) ? themeFg("error", "✗") : themeFg("success", "✓");
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);

            container.addChild(new Spacer(1));
            container.addChild(
              new Text(`${themeFg("muted", "─── ") + themeFg("accent", r.agent)} ${rIcon}`, 0, 0),
            );
            container.addChild(new Text(themeFg("muted", "Task: ") + themeFg("dim", r.task), 0, 0));

            for (const item of displayItems) {
              if (item.type === "toolCall") {
                container.addChild(
                  new Text(
                    themeFg("muted", "→ ") + formatToolCall(item.name, item.args, styled),
                    0,
                    0,
                  ),
                );
              }
            }

            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, markdownTheme));
            }

            const taskUsage = formatUsageStats(r.usage, r.model);
            if (taskUsage) container.addChild(new Text(themeFg("dim", taskUsage), 0, 0));
          }

          // Aggregate usage
          const totalUsage = details.results.reduce(
            (acc, r) => {
              acc.input += r.usage.input;
              acc.output += r.usage.output;
              acc.cacheRead += r.usage.cacheRead;
              acc.cacheWrite += r.usage.cacheWrite;
              acc.cost += r.usage.cost;
              acc.turns += r.usage.turns;
              return acc;
            },
            {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              turns: 0,
              contextTokens: 0,
            },
          );
          const usageStr = formatUsageStats(totalUsage);
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(themeFg("dim", `Total: ${usageStr}`), 0, 0));
          }

          return container;
        }

        // Collapsed parallel (or still running)
        let text = `${icon} ${themeFg("toolTitle", theme.bold("parallel "))}${themeFg("accent", status)}`;
        for (const r of details.results) {
          const rIcon =
            r.exitCode === -1
              ? themeFg("warning", "⏳")
              : isFailedResult(r)
                ? themeFg("error", "✗")
                : themeFg("success", "✓");
          const displayItems = getDisplayItems(r.messages);
          text += `\n\n${themeFg("muted", "─── ")}${themeFg("accent", r.agent)} ${rIcon}`;
          if (displayItems.length === 0)
            text += `\n${themeFg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
          else text += `\n${renderDisplayItems(displayItems, styled, expanded, 5)}`;
        }
        if (!isRunning) {
          const totalUsage = details.results.reduce(
            (acc, r) => {
              acc.input += r.usage.input;
              acc.output += r.usage.output;
              acc.cacheRead += r.usage.cacheRead;
              acc.cacheWrite += r.usage.cacheWrite;
              acc.cost += r.usage.cost;
              acc.turns += r.usage.turns;
              return acc;
            },
            {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              turns: 0,
              contextTokens: 0,
            },
          );
          const usageStr = formatUsageStats(totalUsage);
          if (usageStr) text += `\n\n${themeFg("dim", `Total: ${usageStr}`)}`;
        }
        if (!expanded) text += `\n${themeFg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      // Fallback
      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
    },
  });
}
