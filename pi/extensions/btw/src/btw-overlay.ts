import {
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

/**
 * Theme interface: a subset of Pi's full Theme that this overlay uses.
 */
export interface BtwTheme {
  fg: (color: string, text: string) => string;
}

/**
 * Pure function: render a bordered BTW popup as an array of lines.
 * The returned lines must not exceed `width` in visible (non-ANSI) characters.
 */
export function renderBtwPopup(
  question: string,
  response: string,
  width: number,
  theme: BtwTheme,
): string[] {
  const innerWidth = Math.max(width - 4, 20);
  const horiz = (char: string) => char.repeat(Math.max(0, width - 2));

  const lines: string[] = [];

  // Top border
  lines.push(theme.fg("borderAccent", `┌${horiz("─")}┐`));

  // Title
  const fullTitle = `🤔 BTW: ${question}`;
  const title = truncateToWidth(fullTitle, innerWidth);
  const titlePad = Math.max(0, innerWidth - visibleWidth(title));
  lines.push(
    theme.fg("borderAccent", "│ ") +
      theme.fg("accent", title) +
      " ".repeat(titlePad) +
      theme.fg("borderAccent", " │"),
  );

  // Separator
  lines.push(theme.fg("borderAccent", `├${horiz("─")}┤`));

  // Response body
  if (response.length > 0) {
    for (const rawLine of response.split("\n")) {
      for (const line of wrapLine(rawLine, innerWidth)) {
        const pad = Math.max(0, innerWidth - visibleWidth(line));
        lines.push(
          theme.fg("borderAccent", "│ ") +
            line +
            " ".repeat(pad) +
            theme.fg("borderAccent", " │"),
        );
      }
    }
  } else {
    const empty = theme.fg("muted", "(no response)");
    const pad = Math.max(0, innerWidth - visibleWidth(empty));
    lines.push(
      theme.fg("borderAccent", "│ ") +
        empty +
        " ".repeat(pad) +
        theme.fg("borderAccent", " │"),
    );
  }

  // Footer separator
  lines.push(theme.fg("borderAccent", `├${horiz("─")}┤`));

  // Footer
  const footer = theme.fg("dim", "Esc to close");
  const footerPad = Math.max(0, innerWidth - visibleWidth(footer));
  lines.push(
    theme.fg("borderAccent", "│ ") +
      footer +
      " ".repeat(footerPad) +
      theme.fg("borderAccent", " │"),
  );

  // Bottom border
  lines.push(theme.fg("borderAccent", `└${horiz("─")}┘`));

  return lines;
}

/**
 * TUI overlay component for displaying a BTW response.
 * Dismissible with Escape.
 */
export class BtwOverlay implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly question: string,
    private readonly response: string,
    private readonly theme: BtwTheme,
    private readonly onClose: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    this.cachedLines = renderBtwPopup(
      this.question,
      this.response,
      width,
      this.theme,
    );
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ── Internal word-wrap helper ──────────────────────────────────

function wrapLine(line: string, maxWidth: number): string[] {
  if (line.length === 0) {
    return [""];
  }

  const result: string[] = [];
  const words = line.split(" ");
  let current = "";

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= maxWidth) {
      current = candidate;
    } else {
      if (current.length > 0) {
        result.push(truncateToWidth(current, maxWidth));
      }
      current = word;
    }
  }

  if (current.length > 0) {
    result.push(truncateToWidth(current, maxWidth));
  }

  return result;
}