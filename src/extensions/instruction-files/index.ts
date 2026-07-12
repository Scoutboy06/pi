import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatContextFiles,
  INSTRUCTION_BLOCK_OPEN,
  InstructionFileDiscovery,
} from "./src/context-files.js";

const DISABLE_CONTEXT_FLAGS = new Set(["--no-context-files", "-nc"]);

function contextFilesDisabled(argv = process.argv.slice(2)): boolean {
  return argv.some((argument) => DISABLE_CONTEXT_FLAGS.has(argument));
}

export default function instructionFiles(pi: ExtensionAPI) {
  const discovery = new InstructionFileDiscovery();

  pi.on("before_agent_start", async (event) => {
    if (contextFilesDisabled() || event.systemPrompt.includes(INSTRUCTION_BLOCK_OPEN)) return;

    const loadedContextFiles = event.systemPromptOptions?.contextFiles ?? [];
    const contextFiles = discovery.discover({
      cwd: event.systemPromptOptions?.cwd ?? process.cwd(),
      excludeContents: loadedContextFiles.map((contextFile) => contextFile.content),
      excludePaths: loadedContextFiles.map((contextFile) => contextFile.path),
    });

    if (contextFiles.length === 0) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${formatContextFiles(contextFiles)}`,
    };
  });
}
