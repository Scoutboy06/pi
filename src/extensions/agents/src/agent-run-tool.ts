import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { AgentRunManager, type AgentRunCommandAction } from "./agent-run-manager.js";
import {
  AgentRunRegistry,
  type AgentReportedStatus,
  type AgentRunRecord,
} from "./agent-run-registry.js";

const RunActionSchema = StringEnum(
  ["list", "get", "message", "steer", "follow_up", "abort", "stop"] as const,
  { description: "Operation to perform on durable background agent runs" },
);

const StatusSchema = StringEnum(["working", "paused", "blocked"] as const, {
  description: "Explicit semantic state for the current managed agent run",
});

function formatRun(run: AgentRunRecord): string {
  const parent = run.parentRunId ? ` parent:${run.parentRunId.slice(0, 8)}` : "";
  const detail = run.statusDetail ? ` — ${run.statusDetail}` : "";
  return `${run.id} ${run.agent} [${run.status}]${parent} ${run.cwd}${detail}`;
}

export function registerAgentRunTools(
  pi: ExtensionAPI,
  manager: AgentRunManager,
  registry: AgentRunRegistry,
): void {
  pi.registerTool({
    name: "agent_run",
    label: "Agent Run",
    description:
      "List, inspect, message, steer, abort, or stop durable background agent runs. " +
      "message sends a new prompt to an idle run; steer and follow_up target a working run.",
    promptSnippet: "Inspect and control durable background agent runs",
    promptGuidelines: [
      "Use agent_run to inspect or communicate with background agents previously started by the agent tool.",
    ],
    parameters: Type.Object({
      action: RunActionSchema,
      runId: Type.Optional(Type.String({ description: "Stable background run ID" })),
      message: Type.Optional(
        Type.String({ description: "Message for message, steer, or follow_up" }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (params.action === "list") {
        const runs = manager.list();
        return {
          content: [
            {
              type: "text",
              text: runs.length > 0 ? runs.map(formatRun).join("\n") : "No agent runs.",
            },
          ],
          details: { runs },
        };
      }

      if (!params.runId) throw new Error(`runId is required for ${params.action}`);
      if (params.action === "get") {
        const run = manager.get(params.runId);
        if (!run) throw new Error(`Unknown agent run: ${params.runId}`);
        return { content: [{ type: "text", text: formatRun(run) }], details: { runs: [run] } };
      }

      const action: AgentRunCommandAction = params.action;
      if (
        (action === "message" || action === "steer" || action === "follow_up") &&
        !params.message?.trim()
      ) {
        throw new Error(`message is required for ${action}`);
      }
      const run = await manager.command(params.runId, {
        action,
        ...(params.message?.trim() ? { message: params.message.trim() } : {}),
      });
      return {
        content: [{ type: "text", text: formatRun(run) }],
        details: { runs: [run] },
      };
    },
  });

  const currentRunId = process.env.PI_AGENT_RUN_ID;
  if (!currentRunId) return;

  pi.registerTool({
    name: "agent_report_status",
    label: "Agent Status",
    description:
      "Report the current managed agent's semantic state. Use paused for intentionally suspended work and blocked when external input is required.",
    promptSnippet: "Report working, paused, or blocked state for this managed agent run",
    promptGuidelines: [
      "Use agent_report_status when this managed agent becomes blocked or intentionally paused, and report working when resuming.",
    ],
    parameters: Type.Object({
      status: StatusSchema,
      detail: Type.Optional(
        Type.String({ description: "Concise current activity, blocker, or need" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const status: AgentReportedStatus = params.status;
      const run = registry.report(currentRunId, status, params.detail);
      pi.events.emit("agents:run-updated", run);
      return {
        content: [
          {
            type: "text",
            text: `Run status: ${run.status}${run.statusDetail ? ` — ${run.statusDetail}` : ""}`,
          },
        ],
        details: { run },
      };
    },
  });
}
