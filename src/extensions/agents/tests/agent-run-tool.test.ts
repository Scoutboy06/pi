import { describe, expect, it } from "bun:test";
import { AgentRunRegistry } from "../src/agent-run-registry.js";
import { formatRun } from "../src/agent-run-tool.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("formatRun", () => {
  it("includes the latest assistant text when requested", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-tool-test-"));
    try {
      const registry = new AgentRunRegistry(dir);
      const run = registry.update(
        registry.create({ agent: "worker", agentSource: "project", task: "work", cwd: dir }).id,
        { lastAssistantText: "follow-up output" },
      );

      expect(formatRun(run, true)).toContain("Assistant: follow-up output");
      expect(formatRun(run)).not.toContain("Assistant: follow-up output");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
