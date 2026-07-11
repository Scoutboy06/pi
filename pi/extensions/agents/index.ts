/**
 * Agents Extension — Persona-based agent delegation for pi.
 *
 * Three invocation paths:
 *   - /agent:<name> [task]  — replace current session persona
 *   - /agent:default        — revert to pi's built-in default persona
 *   - --agent <name>         — CLI flag to start session with a persona
 *   - agent("name", task)    — tool the LLM can call to delegate to a sub-agent
 *
 * Agent definitions are markdown files with YAML frontmatter, discovered from:
 *   1. .pi/agents/*.md         (cwd + ancestors)
 *   2. .agents/agents/*.md     (cwd + ancestors)
 *   3. pi/agents/*.md          (config repo)
 *   4. ~/.pi/agent/agents/*.md (global)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./src/agent-loader.js";
import { discoverAgents, formatAgentList } from "./src/agent-loader.js";
import { AgentRunner } from "./src/agent-runner.js";
import { registerAgentTool } from "./src/agent-tool.js";

export default function (pi: ExtensionAPI) {
  const runner = new AgentRunner();

  // ── CLI flag: --agent <name> ─────────────────────────────

  pi.registerFlag("agent", {
    description: "Start the session with a specific agent persona",
    type: "string",
  });

  // ── Session start: register commands + apply CLI agent ───

  pi.on("session_start", async (_event, ctx) => {
    const agents = discoverAgents(ctx.cwd);

    // Register /agent:default command
    pi.registerCommand("agent:default", {
      description: "Revert to pi's built-in default persona",
      handler: async (_args, cmdCtx) => {
        await runner.clear(pi, cmdCtx);
        cmdCtx.ui.notify("Reverted to default agent", "info");
      },
    });

    // Register /agent:<name> commands for each discovered agent
    for (const agent of agents) {
      pi.registerCommand(`agent:${agent.name}`, {
        description: agent.description,
        handler: async (args, cmdCtx) => {
          await runner.apply(agent, pi, cmdCtx);
          cmdCtx.ui.notify(`Agent persona: ${agent.name}`, "info");

          // If user provided a task as args, send it as a user message
          if (args && args.trim()) {
            pi.sendUserMessage(args.trim());
          }
        },
      });
    }

    // Apply CLI agent if --agent flag was set
    const flagValue = pi.getFlag("agent");
    if (typeof flagValue === "string" && flagValue.trim()) {
      const cliAgentName = flagValue.trim();
      const agent = agents.find((a: AgentConfig) => a.name === cliAgentName);

      if (agent) {
        await runner.apply(agent, pi, ctx);
        ctx.ui.notify(`Agent persona: ${agent.name}`, "info");
      } else {
        ctx.ui.notify(
          `Unknown agent "${cliAgentName}". Available: ${formatAgentList(agents)}`,
          "warning",
        );
      }
    }
  });

  // ── before_agent_start: inject agent system prompt ───────

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!runner.isActive()) return;

    const agent = runner.getActive();
    if (!agent) return;

    return {
      systemPrompt: agent.systemPrompt,
    };
  });

  // ── Tool: agent(name, task) for LLM delegation ───────────

  registerAgentTool(pi);
}
