import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, formatSkillsForPrompt, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
  type AutocompleteItem,
} from "@earendil-works/pi-tui";
import { OutputStyleLoader } from "./src/output-style-loader.js";
import { type OutputStyle, OutputStyleRegistry } from "./src/output-style.js";

const STATE_ENTRY_TYPE = "output-style-state";

interface StyleStateEntry {
  type: "custom";
  customType: typeof STATE_ENTRY_TYPE;
  data: { name: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStyleStateEntry(value: unknown): value is StyleStateEntry {
  if (!isRecord(value) || value.type !== "custom" || value.customType !== STATE_ENTRY_TYPE) {
    return false;
  }
  return isRecord(value.data) && typeof value.data.name === "string";
}

function restoreStyleName(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (isStyleStateEntry(entry)) return entry.data.name;
  }
  return undefined;
}

function buildPreservedContext(options: BuildSystemPromptOptions): string {
  const sections: string[] = [];

  if (options.appendSystemPrompt) sections.push(options.appendSystemPrompt);

  if (options.contextFiles && options.contextFiles.length > 0) {
    const context = ["<project_context>", "", "Project-specific instructions and guidelines:", ""];
    for (const file of options.contextFiles) {
      context.push(
        `<project_instructions path=${JSON.stringify(file.path)}>`,
        file.content,
        "</project_instructions>",
        "",
      );
    }
    context.push("</project_context>");
    sections.push(context.join("\n"));
  }

  const hasReadTool = !options.selectedTools || options.selectedTools.includes("read");
  if (hasReadTool && options.skills && options.skills.length > 0) {
    sections.push(formatSkillsForPrompt(options.skills).trim());
  }

  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

export default function outputStyles(pi: ExtensionAPI): void {
  const loader = new OutputStyleLoader();
  let registry: OutputStyleRegistry | undefined;

  pi.registerFlag("output-style", {
    description: "Start with the named output style",
    type: "string",
  });

  function loadRegistry(ctx: ExtensionContext): OutputStyleRegistry {
    const result = loader.load({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      includeProject: ctx.isProjectTrusted(),
    });

    if (registry) registry.replace(result.styles);
    else registry = new OutputStyleRegistry(result.styles);

    if (result.diagnostics.length > 0 && ctx.hasUI) {
      const preview = result.diagnostics
        .slice(0, 3)
        .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
        .join("\n");
      const remainder = result.diagnostics.length - 3;
      ctx.ui.notify(
        `Some output styles could not be loaded:\n${preview}${remainder > 0 ? `\n…and ${remainder} more` : ""}`,
        "warning",
      );
    }

    return registry;
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!registry) return;
    const style = registry.getActive();
    const color = style.name.toLocaleLowerCase() === "default" ? "muted" : "accent";
    ctx.ui.setStatus("output-style", ctx.ui.theme.fg(color, `style:${style.name}`));
  }

  function activate(name: string, ctx: ExtensionContext, persist: boolean): boolean {
    const activeRegistry = registry ?? loadRegistry(ctx);
    const style = activeRegistry.activate(name);
    if (!style) return false;

    if (persist) pi.appendEntry(STATE_ENTRY_TYPE, { name: style.name });
    updateStatus(ctx);
    return true;
  }

  function notifyUnknownStyle(name: string, ctx: ExtensionContext): void {
    const available = (registry ?? loadRegistry(ctx))
      .list()
      .map((style) => style.name)
      .join(", ");
    ctx.ui.notify(`Unknown output style "${name}". Available: ${available}`, "error");
  }

  async function pickStyle(ctx: ExtensionCommandContext): Promise<string | undefined> {
    const activeRegistry = registry ?? loadRegistry(ctx);
    const styles = activeRegistry.list();
    const activeName = activeRegistry.getActive().name;

    if (ctx.mode !== "tui") {
      return ctx.ui.select(
        "Output style",
        styles.map((style) => style.name),
      );
    }

    const items: SelectItem[] = styles.map((style) => ({
      value: style.name,
      label: style.name === activeName ? `${style.name} (active)` : style.name,
      description: `${style.description} · ${style.source}`,
    }));

    const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Select Output Style")), 1, 0));

      const list = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      container.addChild(list);
      container.addChild(
        new Text(theme.fg("dim", "↑↓ navigate • type to search • enter select • esc cancel"), 1, 0),
      );
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

      return {
        render: (width) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });

    return result ?? undefined;
  }

  async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    loadRegistry(ctx);
    const requestedName = args.trim() || (await pickStyle(ctx));
    if (!requestedName) return;

    if (!activate(requestedName, ctx, true)) {
      notifyUnknownStyle(requestedName, ctx);
      return;
    }

    ctx.ui.notify(`Output style set to ${registry?.getActive().name}`, "info");
  }

  function completeStyleName(prefix: string): AutocompleteItem[] | null {
    if (!registry) return null;
    const normalizedPrefix = prefix.trim().toLocaleLowerCase();
    const items = registry
      .list()
      .filter((style) => style.name.toLocaleLowerCase().startsWith(normalizedPrefix))
      .map((style) => ({
        value: style.name,
        label: style.name,
        description: style.description,
      }));
    return items.length > 0 ? items : null;
  }

  const command = {
    description: "Select the response output style",
    getArgumentCompletions: completeStyleName,
    handler: handleCommand,
  };
  pi.registerCommand("output-style", command);
  pi.registerCommand("style", command);

  pi.on("session_start", async (_event, ctx) => {
    const activeRegistry = loadRegistry(ctx);
    const flag = pi.getFlag("output-style");
    const requestedName =
      typeof flag === "string" && flag.trim()
        ? flag.trim()
        : (restoreStyleName(ctx.sessionManager.getBranch()) ?? "Default");

    if (!activeRegistry.activate(requestedName)) {
      activeRegistry.activate("Default");
      if (requestedName !== "Default") notifyUnknownStyle(requestedName, ctx);
    }
    updateStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    const activeRegistry = registry ?? loadRegistry(ctx);
    const restored = restoreStyleName(ctx.sessionManager.getBranch()) ?? "Default";
    if (!activeRegistry.activate(restored)) activeRegistry.activate("Default");
    updateStatus(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!registry) loadRegistry(ctx);
    if (!registry) return;

    return {
      systemPrompt: registry.buildSystemPrompt(
        event.systemPrompt,
        event.systemPromptOptions.cwd ?? ctx.cwd,
        buildPreservedContext(event.systemPromptOptions),
      ),
    };
  });
}

export { restoreStyleName };
export type { OutputStyle };
