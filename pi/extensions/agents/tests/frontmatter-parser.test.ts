import { describe, it, expect } from "bun:test";
import { parseFrontmatter } from "../frontmatter-parser";

describe("parseFrontmatter", () => {
  it("parses simple key-value pairs", () => {
    const result = parseFrontmatter(`---
name: test-agent
description: A test agent
model: sonnet
maxTurns: 20
---
You are a test agent.`);

    expect(result.frontmatter.name).toBe("test-agent");
    expect(result.frontmatter.description).toBe("A test agent");
    expect(result.frontmatter.model).toBe("sonnet");
    expect(result.frontmatter.maxTurns).toBe(20);
    expect(result.body).toBe("You are a test agent.");
  });

  it("parses inline arrays", () => {
    const result = parseFrontmatter(`---
name: reader
tools: [read, grep, glob]
---
Body text.`);

    expect(result.frontmatter.tools).toEqual(["read", "grep", "glob"]);
  });

  it("handles empty arrays", () => {
    const result = parseFrontmatter(`---
name: no-tools
tools: []
---
Body.`);

    expect(result.frontmatter.tools).toEqual([]);
  });

  it("parses booleans", () => {
    const result = parseFrontmatter(`---
name: test
enabled: true
disabled: false
---
Body.`);

    expect(result.frontmatter.enabled).toBe(true);
    expect(result.frontmatter.disabled).toBe(false);
  });

  it("parses numbers", () => {
    const result = parseFrontmatter(`---
name: test
count: 42
negative: -5
---
Body.`);

    expect(result.frontmatter.count).toBe(42);
    expect(result.frontmatter.negative).toBe(-5);
  });

  it("parses literal block scalars with |", () => {
    const result = parseFrontmatter(`---
name: test
initialPrompt: |
  Hello, please review
  the following code carefully.

  Look for bugs.
---
You are a test agent.`);

    expect(result.frontmatter.initialPrompt).toBe(
      "Hello, please review\nthe following code carefully.\n\nLook for bugs.",
    );
  });

  it("trims body whitespace", () => {
    const result = parseFrontmatter(`---
name: test
description: desc
---


Body with surrounding whitespace.


`);

    expect(result.body).toBe("Body with surrounding whitespace.");
  });

  it("handles no frontmatter gracefully", () => {
    const result = parseFrontmatter("Just body text, no frontmatter.");

    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("Just body text, no frontmatter.");
  });

  it("handles frontmatter without closing delimiter", () => {
    const result = parseFrontmatter("---\nname: test\nNo closing delimiter");

    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("---\nname: test\nNo closing delimiter");
  });

  it("skips comments and empty lines in frontmatter", () => {
    const result = parseFrontmatter(`---
# A comment
name: test

description: desc
---
Body.`);

    expect(result.frontmatter.name).toBe("test");
    expect(result.frontmatter.description).toBe("desc");
  });

  it("strips quotes from string values", () => {
    const result = parseFrontmatter(`---
name: "quoted-name"
description: 'single-quoted'
plain: value
---
Body.`);

    expect(result.frontmatter.name).toBe("quoted-name");
    expect(result.frontmatter.description).toBe("single-quoted");
    expect(result.frontmatter.plain).toBe("value");
  });

  it("handles a real code-reviewer agent file", () => {
    const content = `---
name: code-reviewer
description: Expert code reviewer. Use proactively after writing or modifying code.
model: sonnet
tools: [read, grep, glob, bash]
maxTurns: 20
---

You are a senior code reviewer. When invoked:

1. Run \`git diff\` to see recent changes.
2. Focus on modified files.
3. Review for: correctness, security, readability, performance.
4. Report issues organized by severity: critical, warning, suggestion.
5. Include specific examples of how to fix each issue.`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter.name).toBe("code-reviewer");
    expect(result.frontmatter.description).toContain("Expert code reviewer");
    expect(result.frontmatter.model).toBe("sonnet");
    expect(result.frontmatter.tools).toEqual(["read", "grep", "glob", "bash"]);
    expect(result.frontmatter.maxTurns).toBe(20);
    expect(result.body).toContain("You are a senior code reviewer");
    expect(result.body).toContain("git diff");
    expect(result.body).toContain("critical, warning, suggestion");
  });
});
