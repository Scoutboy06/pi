import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { buildContextPrompt } from "./btw-context";
import { BtwOverlay } from "./btw-overlay";

/** Read-only tool names we permit for side queries. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "ls", "agent"]);

/** Maximum seconds before a BTW query times out. */
const BTW_TIMEOUT_MS = 60_000;

export class BtwCommand {
  /**
   * Execute a /btw side query: fork context → spawn sub-agent → show overlay.
   */
  async execute(question: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
    let displayText: string;

    try {
      displayText = await this.runQuery(question, ctx, pi);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      displayText = `Error: ${message}`;
    }

    // ── Show overlay with result ──────────────────────────
    await new Promise<void>((resolve) => {
      ctx.ui.custom<void>(
        (_tui, theme, _kb, done) => {
          const overlay = new BtwOverlay(question, displayText, theme, () => {
            done();
            resolve();
          });
          return overlay;
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "bottom-center",
            width: "90%",
            maxHeight: "50%",
            minWidth: 40,
          },
        },
      );
    });
  }

  /**
   * Core query logic: fork context → spawn sub-agent → return response text.
   */
  private async runQuery(
    question: string,
    ctx: ExtensionCommandContext,
    pi: ExtensionAPI,
  ): Promise<string> {
    // ── 1. Collect conversation context ──────────────────────
    const entries = ctx.sessionManager.getEntries();
    const contextPrompt = buildContextPrompt(entries);

    // ── 2. Build read-only tool list ─────────────────────────
    const readOnlyTools = (pi.getActiveTools() ?? []).filter((name) => READ_ONLY_TOOLS.has(name));

    // ── 3. Show working status ───────────────────────────────
    if (ctx.mode === "tui" && ctx.ui.theme) {
      ctx.ui.setStatus("btw", ctx.ui.theme.fg("accent", "🤔 BTW: thinking…"));
    }

    try {
      // ── 4. Create ephemeral sub-agent session ──────────────
      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);

      const resourceLoader = new DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        systemPromptOverride: () => contextPrompt,
      });
      await resourceLoader.reload();

      const { session: subSession } = await createAgentSession({
        model: ctx.model ?? undefined,
        tools: readOnlyTools,
        noTools: "builtin",
        authStorage,
        modelRegistry,
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.inMemory(),
        resourceLoader,
      });

      // ── 5. Run the query (with timeout) ────────────────────
      let finalText = "";

      subSession.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          finalText += event.assistantMessageEvent.delta;
        }
      });

      try {
        await Promise.race([
          subSession.prompt(question),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("BTW query timed out")), BTW_TIMEOUT_MS),
          ),
        ]);
      } finally {
        subSession.dispose();
      }

      return finalText.trim() || "(no response)";
    } finally {
      ctx.ui.setStatus("btw", undefined);
    }
  }
}
