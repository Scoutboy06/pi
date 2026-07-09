/**
 * Minimal YAML frontmatter parser for agent markdown files.
 *
 * Extracts key-value pairs between the first two `---` delimiters.
 * Supports: strings, numbers, booleans, inline arrays [a, b, c],
 * and literal block scalars (|).
 */

export interface FrontmatterResult {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Parse a markdown file with YAML frontmatter.
 * Returns the parsed frontmatter and the body content.
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  // Find the closing ---
  const afterFirst = trimmed.slice(3);
  const closingIndex = afterFirst.indexOf("\n---");

  if (closingIndex === -1) {
    // No closing delimiter; treat whole thing as body
    return { frontmatter: {}, body: content };
  }

  const fmText = afterFirst.slice(0, closingIndex);
  const body = afterFirst.slice(closingIndex + 4).trim();

  return {
    frontmatter: parseYamlLike(fmText),
    body,
  };
}

/**
 * Parse a simplified YAML-like key-value format.
 * Handles the subset we need for agent frontmatter.
 */
function parseYamlLike(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      i++;
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trim();
    let value = trimmed.slice(colonIndex + 1).trim();

    // Handle literal block scalar: |
    if (value === "|") {
      i++;
      const blockLines: string[] = [];
      // Determine indentation from the next line
      let baseIndent: number | null = null;
      while (i < lines.length) {
        const blockLine = lines[i];
        const blockTrimmed = blockLine.trimStart();
        if (!blockTrimmed && i > 0) {
          // Empty line in a block scalar: keep it
          blockLines.push("");
          i++;
          continue;
        }
        if (baseIndent === null && blockLine !== "") {
          baseIndent = blockLine.length - blockTrimmed.length;
        }
        if (baseIndent !== null && blockLine.length - blockTrimmed.length < baseIndent && blockTrimmed !== "") {
          // Outdented: block ended
          break;
        }
        blockLines.push(blockTrimmed);
        i++;
      }
      result[key] = blockLines.join("\n").trim();
      continue;
    }

    // Handle inline arrays: [item1, item2, item3]
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      if (inner === "") {
        result[key] = [];
      } else {
        result[key] = inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      }
    } else if (value === "true" || value === "false") {
      result[key] = value === "true";
    } else if (/^-?\d+$/.test(value)) {
      result[key] = parseInt(value, 10);
    } else if (/^-?\d+\.\d+$/.test(value)) {
      result[key] = parseFloat(value);
    } else {
      // Strip surrounding quotes if present
      result[key] = value.replace(/^["']|["']$/g, "");
    }

    i++;
  }

  return result;
}