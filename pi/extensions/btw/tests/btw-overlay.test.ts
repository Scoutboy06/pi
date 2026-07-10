import { describe, it, expect, mock, afterEach } from "bun:test";

// Mock pi-tui before importing the overlay module
mock.module("@earendil-works/pi-tui", () => ({
  truncateToWidth: (s: string, w: number) =>
    s.length > w ? s.slice(0, w) : s,
  visibleWidth: (s: string) => s.length,
  matchesKey: (data: string, key: string) =>
    data === "\x1b" && key === "escape",
  Key: { escape: "escape" },
}));

import { BtwOverlay, renderBtwPopup, type BtwTheme } from "../src/btw-overlay";

function mockTheme(): BtwTheme {
  return {
    fg: (_color: string, text: string) => text,
  };
}

describe("renderBtwPopup", () => {
  const theme = mockTheme();

  it("renders a bordered popup with question and response", () => {
    const lines = renderBtwPopup("What is this?", "It is a test response.", 60, theme);

    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(lines[0]).toContain("┌");
    expect(lines[0]).toContain("┐");
    expect(lines[1]).toContain("🤔 BTW: What is this?");
    expect(lines.some((l) => l.includes("It is a test response."))).toBe(true);
    expect(lines[lines.length - 2]).toContain("Esc to close");
    expect(lines[lines.length - 1]).toContain("└");
    expect(lines[lines.length - 1]).toContain("┘");
  });

  it("shows (no response) when response is empty", () => {
    const lines = renderBtwPopup("empty?", "", 60, theme);
    expect(lines.some((l) => l.includes("(no response)"))).toBe(true);
  });

  it("wraps long response lines to fit width", () => {
    const longResponse = "This is a very long response that should be word wrapped across multiple lines in the overlay.";
    const lines = renderBtwPopup("q", longResponse, 40, theme);

    const bodyLines = lines.filter(
      (l) =>
        l.includes("This is a very long") ||
        l.includes("response that should") ||
        l.includes("be word wrapped"),
    );
    expect(bodyLines.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves empty lines in response", () => {
    const lines = renderBtwPopup("q", "Line 1\n\nLine 3", 60, theme);
    // An empty content line renders as border + spaces + border
    const blankContent = lines.filter((l) => {
      const inner = l.replace(/^│ /, "").replace(/ │$/, "");
      return inner.trim().length === 0 && l.includes("│");
    });
    expect(blankContent.length).toBeGreaterThanOrEqual(1);
  });
});

describe("BtwOverlay", () => {
  afterEach(() => {
    // Clear any lingering mock state
  });

  it("calls onClose when escape is pressed", () => {
    let closed = false;
    const overlay = new BtwOverlay("q", "r", mockTheme(), () => {
      closed = true;
    });

    overlay.handleInput("\x1b");
    expect(closed).toBe(true);
  });

  it("does not call onClose for non-escape keys", () => {
    let closed = false;
    const overlay = new BtwOverlay("q", "r", mockTheme(), () => {
      closed = true;
    });

    overlay.handleInput("a");
    overlay.handleInput("\r");
    overlay.handleInput(" ");

    expect(closed).toBe(false);
  });

  it("caches rendered output until invalidated", () => {
    const overlay = new BtwOverlay("q", "r", mockTheme(), () => {});

    const first = overlay.render(60);
    const second = overlay.render(60);

    expect(first).toBe(second);

    overlay.invalidate();
    const third = overlay.render(60);

    expect(third).not.toBe(first);
    expect(third).toEqual(first);
  });

  it("re-renders when width changes", () => {
    const overlay = new BtwOverlay("q", "r", mockTheme(), () => {});

    const narrow = overlay.render(40);
    const wide = overlay.render(80);

    expect(narrow).not.toEqual(wide);
    expect(wide[0].length).toBeGreaterThan(narrow[0].length);
  });
});