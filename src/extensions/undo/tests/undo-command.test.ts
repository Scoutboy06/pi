import { describe, expect, test } from "bun:test";
import { UndoCommand, type UndoContext, type UndoEntry } from "../src/undo-command.js";

class UndoContextStub implements UndoContext {
  idle = true;
  branch: UndoEntry[] = [];
  cancelled = false;
  navigatedTo?: string;
  reset = false;
  editorText?: string;
  notifications: Array<{ message: string; level: "info" | "warning" | "error" }> = [];

  isIdle(): boolean {
    return this.idle;
  }

  getBranch(): UndoEntry[] {
    return this.branch;
  }

  async navigateTree(targetId: string): Promise<{ cancelled: boolean }> {
    this.navigatedTo = targetId;
    return { cancelled: this.cancelled };
  }

  resetLeaf(): void {
    this.reset = true;
  }

  setEditorText(text: string): void {
    this.editorText = text;
  }

  notify(message: string, level: "info" | "warning" | "error"): void {
    this.notifications.push({ message, level });
  }
}

describe("UndoCommand", () => {
  test("navigates before the latest user turn and restores its text", async () => {
    const context = new UndoContextStub();
    context.branch = [
      { id: "first", parentId: null, type: "message", message: { role: "user", content: "first" } },
      { id: "reply", parentId: "first", type: "message", message: { role: "assistant" } },
      {
        id: "latest",
        parentId: "reply",
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "image", data: "ignored" },
            { type: "text", text: "world" },
          ],
        },
      },
      { id: "answer", parentId: "latest", type: "message", message: { role: "assistant" } },
    ];

    await new UndoCommand().execute(context);

    expect(context.navigatedTo).toBe("reply");
    expect(context.editorText).toBe("hello world");
  });

  test("resets the leaf for the first user message", async () => {
    const context = new UndoContextStub();
    context.branch = [
      { id: "first", parentId: null, type: "message", message: { role: "user", content: "start" } },
    ];

    await new UndoCommand().execute(context);

    expect(context.reset).toBeTrue();
    expect(context.editorText).toBe("start");
  });

  test("does nothing while Pi is busy", async () => {
    const context = new UndoContextStub();
    context.idle = false;

    await new UndoCommand().execute(context);

    expect(context.editorText).toBeUndefined();
    expect(context.notifications[0]?.level).toBe("warning");
  });

  test("reports when there is no user message", async () => {
    const context = new UndoContextStub();

    await new UndoCommand().execute(context);

    expect(context.notifications[0]?.message).toContain("no user message");
  });

  test("leaves the editor unchanged when navigation is cancelled", async () => {
    const context = new UndoContextStub();
    context.cancelled = true;
    context.branch = [
      { id: "root", parentId: null, type: "custom" },
      {
        id: "user",
        parentId: "root",
        type: "message",
        message: { role: "user", content: "retry" },
      },
    ];

    await new UndoCommand().execute(context);

    expect(context.editorText).toBeUndefined();
  });

  test("warns when an image-only message cannot be restored", async () => {
    const context = new UndoContextStub();
    context.branch = [
      {
        id: "first",
        parentId: null,
        type: "message",
        message: { role: "user", content: [{ type: "image", data: "ignored" }] },
      },
    ];

    await new UndoCommand().execute(context);

    expect(context.editorText).toBe("");
    expect(context.notifications[0]?.message).toContain("images cannot be restored");
  });
});
