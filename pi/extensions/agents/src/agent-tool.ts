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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { discoverAgentsScoped, type AgentConfig, type AgentScope } from "./agent-loader";
import {
  runSubagent,
  runChain,
  runParallel,
  formatUsageStats,
  formatToolCall,
  getDisplayItems,
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  type DisplayItem,
  type OnUpdateCallback,
  type SingleResult,
  type SubagentDetails,
} from "./agent-runner";

// ── Constants ──────────────────────────────────────────────────

const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024; // 50 KB

// ── Tool parameter schemas ─────────────────────────────────────

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
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

export function registerAgentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agent",
    label: "Agent",
    description:
      "Delegate tasks to specialized agent personas with isolated context. " +
      "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder). " +
      'Default scope is "user" (global agents). Use agentScope: "both" to include project agents. ' +
      "Agents are defined in pi/agents/, .pi/agents/, .agents/agents/, or ~/.pi/agent/agents/.",
    promptSnippet: "Delegate a task to a specialized agent persona (single, parallel, or chain)",
    promptGuidelines: [
      "Use the agent tool to delegate focused tasks to specialized personas. " +
        "Available agents are listed in the system prompt. Each agent has specific tools and a tailored system prompt. " +
        "For multiple independent tasks, use parallel mode with the tasks array. " +
        "For sequential tasks where each step depends on the previous, use chain mode with the {previous} placeholder.",
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
        });

      // ── Validation ──────────────────────────────────────────

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

        const projectAgentsRequested = Array.from(requestedAgentNames)
          .map((name) => agents.find((a) => a.name === name))
          .filter((a): a is AgentConfig => a?.source === "project" || a?.source === "config");

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
        const { results, finalOutput, isError } = await runChain(
          params.chain,
          ctx.cwd,
          agentScope,
          signal,
          onUpdate as OnUpdateCallback | undefined,
          discovery.projectAgentsDir,
        );

        return {
          content: [{ type: "text", text: finalOutput }],
          details: makeDetails("chain")(results),
          isError,
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

        const { results, isError } = await runParallel(
          params.tasks,
          ctx.cwd,
          agentScope,
          signal,
          onUpdate as OnUpdateCallback | undefined,
          discovery.projectAgentsDir,
        );

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
          return `### [${r.agent}] ${status}\n\n${truncated}`;
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

        const result = await runSubagent(
          agent,
          params.task as string,
          params.cwd ?? ctx.cwd,
          signal,
          onUpdate as OnUpdateCallback | undefined,
          makeDetails("single"),
        );

        const isError = isFailedResult(result);
        if (isError) {
          const errorMsg = getResultOutput(result);
          return {
            content: [
              {
                type: "text",
                text: `Agent ${result.stopReason || "failed"}: ${errorMsg}`,
              },
            ],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
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
        const chain = args.chain as Array<{ agent: string; task: string }>;
        let text =
          themeFg("toolTitle", theme.bold("agent ")) +
          themeFg("accent", `chain (${chain.length} steps)`) +
          themeFg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(chain.length, 3); i++) {
          const step = chain[i];
          const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
          const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text +=
            "\n  " +
            themeFg("muted", `${i + 1}.`) +
            " " +
            themeFg("accent", step.agent) +
            themeFg("dim", ` ${preview}`);
        }
        if (chain.length > 3) text += `\n  ${themeFg("muted", `... +${chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }

      // Parallel mode
      if (args.tasks && Array.isArray(args.tasks) && args.tasks.length > 0) {
        const tasks = args.tasks as Array<{ agent: string; task: string }>;
        let text =
          themeFg("toolTitle", theme.bold("agent ")) +
          themeFg("accent", `parallel (${tasks.length} tasks)`) +
          themeFg("muted", ` [${scope}]`);
        for (const t of tasks.slice(0, 3)) {
          const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          text += `\n  ${themeFg("accent", t.agent)}${themeFg("dim", ` ${preview}`)}`;
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
        themeFg("muted", ` [${scope}]`);
      text += `\n  ${themeFg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    // ── renderResult ──────────────────────────────────────────

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as SubagentDetails | undefined;
      const themeFg = theme.fg.bind(theme);

      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      // ── Single mode rendering ───────────────────────────────

      if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
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
                    themeFg("muted", "→ ") + formatToolCall(item.name, item.args, themeFg),
                    0,
                    0,
                  ),
                );
            }
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0));
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
          text += `\n${renderDisplayItems(displayItems, themeFg, expanded, COLLAPSED_ITEM_COUNT)}`;
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
                    themeFg("muted", "→ ") + formatToolCall(item.name, item.args, themeFg),
                    0,
                    0,
                  ),
                );
              }
            }

            // Show final output as markdown
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0));
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
            { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
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
          else text += `\n${renderDisplayItems(displayItems, themeFg, expanded, 5)}`;
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
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
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
                    themeFg("muted", "→ ") + formatToolCall(item.name, item.args, themeFg),
                    0,
                    0,
                  ),
                );
              }
            }

            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0));
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
            { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
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
          else text += `\n${renderDisplayItems(displayItems, themeFg, expanded, 5)}`;
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
            { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
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
