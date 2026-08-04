import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRunRegistry } from "../src/agent-run-registry.js";

let tmpDir: string;
let registry: AgentRunRegistry;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-runs-test-"));
  registry = new AgentRunRegistry(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("AgentRunRegistry", () => {
  it("creates durable records with stable hierarchy and tags", () => {
    const run = registry.create({
      agent: "translator",
      agentSource: "project",
      task: "Translate batch 1",
      cwd: tmpDir,
      parentRunId: "director-run",
      tags: ["translations", "batch-1"],
    });

    const restored = registry.get(run.id);

    expect(restored?.id).toBe(run.id);
    expect(restored?.status).toBe("starting");
    expect(restored?.parentRunId).toBe("director-run");
    expect(restored?.tags).toEqual(["translations", "batch-1"]);
    expect(fs.statSync(registry.getRecordPath(run.id)).mode & 0o777).toBe(0o600);
  });

  it("updates lifecycle state without changing identity", () => {
    const run = registry.create({
      agent: "worker",
      agentSource: "config",
      task: "Work",
      cwd: tmpDir,
    });

    const updated = registry.update(run.id, {
      status: "working",
      lastEvent: "agent_start",
      pid: process.pid,
    });

    expect(updated.id).toBe(run.id);
    expect(updated.status).toBe("working");
    expect(updated.lastEvent).toBe("agent_start");
    expect(updated.pid).toBe(process.pid);
  });

  it("merges explicit blocked state while preserving lifecycle data", () => {
    const run = registry.create({
      agent: "worker",
      agentSource: "project",
      task: "Work",
      cwd: tmpDir,
    });
    registry.update(run.id, { status: "idle", sessionFile: "/tmp/session.jsonl" });

    const blocked = registry.report(run.id, "blocked", "Need a scope decision");

    expect(blocked.status).toBe("blocked");
    expect(blocked.statusDetail).toBe("Need a scope decision");
    expect(blocked.sessionFile).toBe("/tmp/session.jsonl");
  });

  it("clears a paused or blocked report when work resumes", () => {
    const run = registry.create({
      agent: "worker",
      agentSource: "project",
      task: "Work",
      cwd: tmpDir,
    });
    registry.update(run.id, { status: "working" });
    registry.report(run.id, "blocked", "Need input");

    const working = registry.report(run.id, "working");

    expect(working.status).toBe("working");
    expect(working.statusDetail).toBeUndefined();
    expect(fs.existsSync(registry.getStatusPath(run.id))).toBe(false);
  });

  it("does not let a stale semantic report override a stopped process", () => {
    const run = registry.create({
      agent: "worker",
      agentSource: "project",
      task: "Work",
      cwd: tmpDir,
    });
    registry.report(run.id, "paused", "Waiting");

    const stopped = registry.update(run.id, { status: "stopped" });

    expect(stopped.status).toBe("stopped");
  });

  it("lists newest records first", async () => {
    const first = registry.create({
      agent: "first",
      agentSource: "global",
      task: "First",
      cwd: tmpDir,
    });
    await Bun.sleep(2);
    const second = registry.create({
      agent: "second",
      agentSource: "global",
      task: "Second",
      cwd: tmpDir,
    });

    expect(registry.list().map((run) => run.id)).toEqual([second.id, first.id]);
  });
});
