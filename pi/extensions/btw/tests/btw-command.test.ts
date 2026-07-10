import { describe, it, expect } from "bun:test";
import { buildContextPrompt, extractText } from "../src/btw-context";

describe("buildContextPrompt", () => {
  it("returns empty context message when no entries", () => {
    const prompt = buildContextPrompt([]);
    expect(prompt).toContain("no prior conversation");
  });

  it("includes user and assistant messages in context", () => {
    const entries = [
      { role: "user", content: "Hello, can you help me write a function?" },
      { role: "assistant", content: "Of course! What kind of function do you need?" },
      { role: "user", content: "A Fibonacci function in TypeScript." },
    ];

    const prompt = buildContextPrompt(entries);

    expect(prompt).toContain("**User**: Hello, can you help");
    expect(prompt).toContain("**Assistant**: Of course!");
    expect(prompt).toContain("**User**: A Fibonacci function");
    expect(prompt).toContain("side query");
    expect(prompt).toContain("read-only tool access");
  });

  it("truncates long assistant messages", () => {
    const longMessage = "A".repeat(1000);
    const entries = [
      { role: "user", content: "Explain this" },
      { role: "assistant", content: longMessage },
    ];

    const prompt = buildContextPrompt(entries);

    expect(prompt.length).toBeLessThan(longMessage.length + 200);
    expect(prompt).toContain("…");
  });

  it("limits to last 30 entries", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `Message ${i}`,
    }));

    const prompt = buildContextPrompt(entries);

    expect(prompt).not.toContain("Message 0");
    expect(prompt).not.toContain("Message 19");
    expect(prompt).toContain("Message 20");
    expect(prompt).toContain("Message 49");
  });
});

describe("extractText", () => {
  it("returns plain strings unchanged", () => {
    expect(extractText("Hello world")).toBe("Hello world");
  });

  it("extracts text from content blocks", () => {
    const content = [
      { type: "text", text: "First block" },
      { type: "text", text: "Second block" },
      { type: "image", url: "data:..." },
    ];

    expect(extractText(content)).toBe("First block\nSecond block");
  });

  it("handles empty content arrays", () => {
    expect(extractText([])).toBe("");
  });

  it("handles blocks with missing text", () => {
    const content = [{ type: "text" }, { type: "text", text: "Has text" }];
    expect(extractText(content)).toBe("\nHas text");
  });

  it("falls back to JSON.stringify for unknown shapes", () => {
    const result = extractText({ custom: "value" });
    expect(result).toContain("custom");
  });

  it("returns empty string for null content", () => {
    expect(extractText(null)).toBe("");
  });

  it("returns empty string for undefined content", () => {
    expect(extractText(undefined)).toBe("");
  });

  it("filters out null entries in content blocks", () => {
    const content = [
      null,
      { type: "text", text: "valid" },
      undefined,
      { type: "text", text: "also valid" },
    ];
    expect(extractText(content)).toBe("valid\nalso valid");
  });
});
