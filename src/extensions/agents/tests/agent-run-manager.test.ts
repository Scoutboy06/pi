import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../src/agent-loader.js";
import {
  AgentRunManager,
  type AgentRunEventSink,
  type AgentWorkerLaunchConfig,
  type AgentWorkerLauncher,
} from "../src/agent-run-manager.js";
import { AgentRunRegistry, type AgentRunRecord } from "../src/agent-run-registry.js";

let tmpDir: string;
let registry: AgentRunRegistry;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-manager-test-"));
  registry = new AgentRunRegistry(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

class WorkerLauncher implements AgentWorkerLauncher {
  config?: AgentWorkerLaunchConfig;

  launch(configPath: string): number {
    const value: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!value || typeof value !== "object") throw new Error("Expected launch config");
    const config = value as AgentWorkerLaunchConfig;
    this.config = config;
    fs.mkdirSync(path.dirname(registry.getSocketPath(config.runId)), { recursive: true });
    fs.writeFileSync(registry.getSocketPath(config.runId), "ready");
    return process.pid;
  }
}

class EventSink implements AgentRunEventSink {
  readonly updates: AgentRunRecord[] = [];

  emit(channel: string, data: unknown): void {
    if (channel !== "agents:run-updated" || !data || typeof data !== "object") return;
    this.updates.push(data as AgentRunRecord);
  }
}

const agent: AgentConfig = {
  name: "worker",
  description: "Works",
  systemPrompt: "Work carefully",
  source: "project",
  filePath: "/tmp/worker.md",
};

describe("AgentRunManager", () => {
  it("starts a durable worker and emits its stable run record", async () => {
    const launcher = new WorkerLauncher();
    const events = new EventSink();
    const manager = new AgentRunManager(registry, launcher, events);

    const run = await manager.start(agent, "Do work", tmpDir, ["workflow"]);

    expect(run.status).toBe("starting");
    expect(run.pid).toBe(process.pid);
    expect(run.tags).toEqual(["workflow"]);
    expect(launcher.config?.runId).toBe(run.id);
    expect(launcher.config?.agentName).toBe("worker");
    expect(events.updates.at(-1)?.id).toBe(run.id);
  });

  it("keeps a detached RPC worker messageable until stopped", async () => {
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir);
    const fakePiPath = path.join(binDir, "pi");
    fs.writeFileSync(
      fakePiPath,
      `#!/usr/bin/env bun
let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const newline = buffer.indexOf("\\n");
    const command = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    const respond = (data) => process.stdout.write(JSON.stringify(data) + "\\n");
    respond({ type: "response", id: command.id, command: command.type, success: true,
      ...(command.type === "get_state" ? { data: { sessionFile: "/tmp/fake-session.jsonl", model: { provider: "fake", id: "model" } } } : {}) });
    if (command.type === "prompt") {
      respond({ type: "agent_start" });
      respond({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
      respond({ type: "agent_settled" });
    }
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    const manager = new AgentRunManager(registry);

    try {
      const run = await manager.start(agent, "Do work", tmpDir);
      let current = run;
      for (let attempt = 0; attempt < 50 && current.status !== "idle"; attempt++) {
        await Bun.sleep(20);
        current = manager.get(run.id) ?? current;
      }
      expect(current.status).toBe("idle");
      expect(current.sessionFile).toBe("/tmp/fake-session.jsonl");
      expect(current.lastAssistantText).toBe("done");

      await manager.command(run.id, { action: "message", message: "Continue" });
      await manager.command(run.id, { action: "stop" });
      for (let attempt = 0; attempt < 50 && current.status !== "stopped"; attempt++) {
        await Bun.sleep(20);
        current = manager.get(run.id) ?? current;
      }
      expect(current.status).toBe("stopped");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("sends control commands over the run socket", async () => {
    const run = registry.create({
      agent: "worker",
      agentSource: "project",
      task: "Do work",
      cwd: tmpDir,
    });
    fs.mkdirSync(path.dirname(run.socketPath), { recursive: true });
    let received: unknown;
    const server = net.createServer((socket) => {
      socket.setEncoding("utf-8");
      socket.on("data", (data: string) => {
        received = JSON.parse(data.trim());
        socket.end(`${JSON.stringify({ success: true, run })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(run.socketPath, resolve));
    const manager = new AgentRunManager(registry);

    const result = await manager.command(run.id, { action: "steer", message: "Change course" });

    expect(result.id).toBe(run.id);
    expect(received).toEqual({ action: "steer", message: "Change course" });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
