/**
 * Agent Tool — registers the `agent` tool that the LLM can call to
 * delegate work to a sub-agent persona.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { discoverAgents } from "./agent-loader";
import { runSubagent } from "./agent-runner";

// ── Tool parameter schema ──────────────────────────────────────

const AgentToolParams = Type.Object({
  agent: Type.String({ description: "Name of the agent persona to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
});

// ── Tool registration ──────────────────────────────────────────

export function registerAgentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agent",
    label: "Agent",
    description:
      "Delegate a task to a specialized agent persona. Agents are defined in pi/agents/, " +
      ".pi/agents/, .agents/agents/, or ~/.pi/agent/agents/. " +
      "Use this to search codebases, plan implementations, review code, or any task " +
      "that benefits from a focused persona with specific tools and instructions.",
    promptSnippet: "Delegate a task to a specialized agent persona",
    promptGuidelines: [
      "Use the agent tool to delegate focused tasks to specialized personas. " +
        "Available agents are listed in the system prompt. Each agent has specific tools and a tailored system prompt.",
    ],
    parameters: AgentToolParams,

    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      ctx,
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: Record<string, unknown>;
      isError?: boolean;
    }> {
      const agents = discoverAgents(ctx.cwd);
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
          details: {},
          isError: true,
        };
      }

      const result = await runSubagent(agent, params.task, ctx.cwd, signal);

      if (result.exitCode !== 0) {
        const errorMsg = result.stderr || result.output || "sub-agent failed";
        return {
          content: [{ type: "text", text: `Agent "${params.agent}" failed: ${errorMsg}` }],
          details: { agent: params.agent, task: params.task, ...result },
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: result.output || "(no output)",
          },
        ],
        details: { agent: params.agent, task: params.task, ...result },
      };
    },

    renderCall(args, theme, _context) {
      const agentName = (args.agent as string) || "...";
      const preview =
        args.task && typeof args.task === "string"
          ? args.task.length > 60
            ? `${args.task.slice(0, 60)}...`
            : args.task
          : "...";
      let text = theme.fg("toolTitle", theme.bold("agent ")) + theme.fg("accent", agentName);
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as Record<string, unknown> | undefined;
      const agentName = (details?.agent as string) || "unknown";
      const isError = result.isError === true;
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

      if (expanded) {
        let text = `${icon} ${theme.fg("toolTitle", theme.bold(agentName))}`;
        if (isError) {
          text += `\n${theme.fg("error", result.content[0]?.type === "text" ? result.content[0].text : "error")}`;
        } else {
          text += `\n${theme.fg("toolOutput", result.content[0]?.type === "text" ? result.content[0].text : "")}`;
        }
        return new Text(text, 0, 0);
      }

      // Collapsed view
      const outputText = result.content[0]?.type === "text" ? result.content[0].text : "";
      const preview = outputText.length > 200 ? `${outputText.slice(0, 200)}...` : outputText;
      let text = `${icon} ${theme.fg("toolTitle", theme.bold(agentName))}`;
      text += `\n${theme.fg("toolOutput", preview || "(no output)")}`;
      if (outputText.length > 200) {
        text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      }
      return new Text(text, 0, 0);
    },
  });
}
