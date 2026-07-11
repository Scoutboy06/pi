/**
 * Pure function: extract readable text from a message content block.
 * No Pi dependencies — testable in isolation.
 */
export function extractText(content: unknown): string {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return (content as Array<{ type: string; text?: string }>)
      .filter((c) => c != null && c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }
  return JSON.stringify(content) ?? "";
}

/**
 * Pure function: build a system prompt from conversation entries.
 * No Pi dependencies — testable in isolation.
 */
export function buildContextPrompt(
  entries: ReadonlyArray<{ role: string; content: unknown }>,
): string {
  if (entries.length === 0) {
    return "You are answering a side query. The user has no prior conversation.";
  }

  const recent = entries.slice(-30);

  let prompt = "You are answering a **side query** (BTW) about the following conversation. ";
  prompt += "You have read-only tool access (read, grep, glob, ls). ";
  prompt += "Do NOT make any edits or run destructive commands. ";
  prompt += "Respond concisely — this is a quick side question.\n\n";
  prompt += "## Conversation Context\n\n";

  for (const entry of recent) {
    const text = extractText(entry.content);

    if (entry.role === "user") {
      prompt += `**User**: ${text}\n\n`;
    } else if (entry.role === "assistant") {
      if (text.length > 800) {
        prompt += `**Assistant**: ${text.slice(0, 800)}…\n\n`;
      } else {
        prompt += `**Assistant**: ${text}\n\n`;
      }
    }
  }

  return prompt;
}
