import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile, readdir } from "node:fs/promises";

import { AgentDefinition } from "./agent-definition";
import { MarkdownAgentLoader } from "./agent-loader";
import { AgentRegistry } from "./agent-registry";
import { AgentModelResolver } from "./agent-model-resolver";
import { AgentRunner, type AgentRunnerContext } from "./agent-runner";

export default async function (pi: ExtensionAPI) {
  // ── Resolve paths ────────────────────────────────────────────
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const agentsDir = resolve(__dirname, "..", "..", "agents");

  // ── Load agent definitions ───────────────────────────────────
  const loader = new MarkdownAgentLoader(
    (path: string) => readFile(path, "utf-8"),
    (path: string) => readdir(path),
  );
  const { registry, errors: loadErrors } = await AgentRegistry.fromLoader(loader, agentsDir);

  // ── Load model aliases ───────────────────────────────────────
  let modelResolver: AgentModelResolver;
  try {
    const modelsJson = await readFile(resolve(agentsDir, "models.json"), "utf-8");
    modelResolver = AgentModelResolver.fromJson(modelsJson);
  } catch {
    modelResolver = new AgentModelResolver({});
  }

  // ── Auth & model infrastructure for sub-agents ──────────────
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  // ── Active agent state ───────────────────────────────────────
  let activeAgent: AgentDefinition | undefined;
  let activeAgentSource: "flag" | "command" | undefined;

  // ── Agent runner context (sub-agent spawning) ────────────────
  function createRunnerContext(ctx: ExtensionContext, parentTools: string[]): AgentRunnerContext {
    return {
      resolveModel(modelRef: string) {
        const resolved = modelResolver.resolve(modelRef);
        if (resolved.type === "concrete") return resolved;
        return "inherit";
      },
      async runSubAgent(config) {
        // Resolve model object
        let modelObj;
        if (config.model !== "inherit") {
          modelObj = ctx.modelRegistry.find(config.model.provider, config.model.model);
        }

        const resourceLoader = new DefaultResourceLoader({
          systemPromptOverride: () => config.systemPrompt,
        });
        await resourceLoader.reload();

        const { session: subSession } = await createAgentSession({
          model: modelObj,
          tools: config.tools,
          noTools: "builtin",
          authStorage,
          modelRegistry,
          sessionManager: SessionManager.inMemory(),
          settingsManager: SettingsManager.inMemory(),
          resourceLoader,
        });

        // Collect output
        let finalText = "";
        let turns = 0;
        let error: string | undefined;

        subSession.subscribe((event) => {
          if (event.type === "turn_end") {
            turns++;
          }
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            finalText += event.assistantMessageEvent.delta;
          }
        });

        try {
          await subSession.prompt(config.task);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        } finally {
          subSession.dispose();
        }

        return {
          text: finalText.trim(),
          turns,
          truncated: config.maxTurns ? turns >= config.maxTurns : false,
          error,
        };
      },
    };
  }

  // ── Apply agent to main session ─────────────────────────────
  async function applyAgent(
    def: AgentDefinition,
    ctx: ExtensionContext,
    source: "flag" | "command",
  ): Promise<void> {
    activeAgent = def;
    activeAgentSource = source;

    // Set model
    const resolved = modelResolver.resolve(def.model);
    if (resolved.type === "concrete") {
      const model = ctx.modelRegistry.find(resolved.provider, resolved.model);
      if (model) {
        await pi.setModel(model);
      }
    }

    // Set tools
    const parentTools = pi.getActiveTools();
    const effectiveTools = def.resolveTools(parentTools);
    pi.setActiveTools(effectiveTools);
  }

  // ── Register --agent flag ────────────────────────────────────
  pi.registerFlag("agent", {
    description: "Run session as a specific agent",
    type: "string",
  });

  // ── session_start: handle --agent flag ──────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const agentName = pi.getFlag("agent");
    if (agentName && typeof agentName === "string") {
      const def = registry.get(agentName);
      if (def) {
        await applyAgent(def, ctx, "flag");
      } else {
        ctx.ui.notify(
          `Agent "${agentName}" not found. Available: ${registry.names.join(", ")}`,
          "warning",
        );
      }
    }

    // Log load errors
    for (const err of loadErrors) {
      ctx.ui.notify(`Agent load error in ${err.file}: ${err.message}`, "error");
    }
  });

  // ── Register /agent:name commands ────────────────────────────
  for (const def of registry.list()) {
    pi.registerCommand(`agent:${def.name}`, {
      description: def.description,
      handler: async (args, ctx) => {
        await applyAgent(def, ctx, "command");

        const msg = `Now running as ${def.name}`;
        if (args) {
          ctx.ui.notify(`${msg}. Sending: "${args}"`, "info");
          pi.sendUserMessage(args);
        } else {
          ctx.ui.notify(msg, "info");
        }
      },
    });
  }

  // ── before_agent_start: inject agent system prompt ─────────
  pi.on("before_agent_start", async (event, _ctx) => {
    if (activeAgent) {
      // Prepend the agent's system prompt to the existing one
      return {
        systemPrompt: activeAgent.systemPrompt + "\n\n---\n\n" + event.systemPrompt,
      };
    }
  });

  // ── Register agent tool for automatic delegation ────────────
  pi.registerTool({
    name: "agent",
    label: "Agent",
    description: `Delegate a task to a specialized agent. Available agents: ${registry.list().map((d) => `${d.name} — ${d.description}`).join("; ")}`,
    promptSnippet: "Delegate a task to a specialized agent",
    promptGuidelines: [
      `Use the agent tool to delegate tasks to specialized agents. Available agents: ${registry.list().map((d) => d.name).join(", ")}. Each agent has a specific focus and tool set.`,
    ],
    parameters: Type.Object({
      agent: Type.String({ description: `Name of the agent to delegate to` }),
      task: Type.String({ description: "Detailed task description for the agent" }),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const def = registry.get(params.agent);
      if (!def) {
        return {
          content: [
            {
              type: "text",
              text: `Agent "${params.agent}" not found. Available agents: ${registry.names.join(", ")}`,
            },
          ],
        };
      }

      const parentTools = pi.getActiveTools();
      const runner = new AgentRunner(def, modelResolver, parentTools);
      const runnerCtx = createRunnerContext(ctx, parentTools);

      const result = await runner.run(params.task, runnerCtx);

      if (result.error) {
        return {
          content: [
            {
              type: "text",
              text: `Agent ${def.name} encountered an error: ${result.error}`,
            },
          ],
        };
      }

      let responseText = result.text || "(agent produced no output)";
      if (result.truncated) {
        responseText += `\n\n[Agent reached max turns (${def.maxTurns}) and was truncated.]`;
      }

      return {
        content: [{ type: "text", text: responseText }],
        details: { agentName: def.name, turns: result.turns, truncated: result.truncated },
      };
    },
  });
}