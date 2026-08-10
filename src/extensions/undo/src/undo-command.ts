export interface UndoEntry {
  id: string;
  parentId: string | null;
  type: string;
  message?: {
    role: string;
    content?: unknown;
  };
}

export interface UndoContext {
  isIdle(): boolean;
  getBranch(): UndoEntry[];
  navigateTree(targetId: string): Promise<{ cancelled: boolean }>;
  resetLeaf(): void;
  setEditorText(text: string): void;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export class UndoCommand {
  async execute(context: UndoContext): Promise<void> {
    if (!context.isIdle()) {
      context.notify("Cannot undo while Pi is working", "warning");
      return;
    }

    const userEntry = context
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message?.role === "user");

    if (!userEntry) {
      context.notify("There is no user message to undo", "info");
      return;
    }

    const text = this.extractText(userEntry.message?.content);

    if (userEntry.parentId === null) {
      context.resetLeaf();
    } else {
      const result = await context.navigateTree(userEntry.parentId);
      if (result.cancelled) return;
    }

    context.setEditorText(text);
    if (text.length === 0) {
      context.notify("Undid the message, but its images cannot be restored", "warning");
    }
  }

  private extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "text" &&
          "text" in block &&
          typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("");
  }
}
