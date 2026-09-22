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

class FailingStopLauncher extends WorkerLauncher {
  terminatedPid?: number;

  terminate(pid: number): void {
    this.terminatedPid = pid;
  }
}

class InitialTurnLauncher extends WorkerLauncher {
  launch(configPath: string): number {
    const pid = super.launch(configPath);
    const runId = this.config?.runId;
    if (runId) {
      setTimeout(
        () =>
          registry.update(runId, {
            status: "idle",
            lastAssistantText: "initial output",
            lastEvent: "agent_settled",
            settledGeneration: 1,
            initialTurnCaptured: true,
          }),
        10,
      );
    }
    return pid;
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

    const run = await manager.start(
      { ...agent, model: "openai-codex/gpt-5.6-luna" },
      "Do work",
      tmpDir,
      ["workflow"],
    );

    expect(run.status).toBe("starting");
    expect(run.pid).toBe(process.pid);
    expect(run.tags).toEqual(["workflow"]);
    expect(launcher.config?.runId).toBe(run.id);
    expect(launcher.config?.agentName).toBe("worker");
    expect(launcher.config?.model).toBe("openai-codex/gpt-5.6-luna");
    expect(events.updates.at(-1)?.id).toBe(run.id);
  });

  it("waits for the initial turn only when requested", async () => {
    const manager = new AgentRunManager(registry, new InitialTurnLauncher());
    const updates: string[] = [];

    const run = await manager.start(agent, "Do work", tmpDir, [], {
      waitForInitialTurn: true,
      onUpdate: (update) => updates.push(update.status),
    });

    expect(run.status).toBe("idle");
    expect(run.lastAssistantText).toBe("initial output");
    expect(updates).toContain("starting");
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
    if (command.type === "prompt" || command.type === "follow_up") {
      respond({ type: "agent_start" });
      respond({ type: "message_end", message: { role: "assistant", model: "fake/model", stopReason: "end", usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 0.01 } }, content: [{ type: "text", text: "done" }, { type: "toolCall", name: "read", arguments: { path: "x" } }] } });
      respond({ type: "tool_result_end", message: { role: "toolResult", toolCallId: "1", content: [{ type: "text", text: "result" }] } });
      if (command.type === "follow_up") {
        respond({ type: "message_end", message: { role: "assistant", model: "fake/model", content: [{ type: "text", text: "follow-up output" }] } });
        respond({ type: "tool_result_end", message: { role: "toolResult", content: [{ type: "text", text: "follow-up result" }] } });
      }
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
      for (
        let attempt = 0;
        attempt < 50 && (current.status !== "idle" || !current.sessionFile);
        attempt++
      ) {
        await Bun.sleep(20);
        current = manager.get(run.id) ?? current;
      }
      expect(current.status).toBe("idle");
      expect(current.sessionFile).toBe("/tmp/fake-session.jsonl");
      expect(current.lastAssistantText).toBe("done");
      expect(current.messages?.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
      expect(current.messages?.[0]?.content).toHaveLength(2);
      expect(current.usage).toMatchObject({ input: 7, output: 3, turns: 1, contextTokens: 10 });
      expect(current.model).toBe("fake/model");
      expect(current.stopReason).toBe("end");

      const initialMessages = current.messages;
      const followUp = await manager.command(run.id, { action: "follow_up", message: "Continue" });
      current = manager.get(run.id) ?? current;
      expect(followUp.settledGeneration).toBe(2);
      expect(followUp.messages).toEqual(initialMessages);
      expect(followUp.lastAssistantText).toBe("follow-up output");
      expect(current.lastAssistantText).toBe("follow-up output");

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

  it("falls back to terminating the detached worker when stop RPC fails", async () => {
    const launcher = new FailingStopLauncher();
    const manager = new AgentRunManager(registry, launcher);
    const run = await manager.start(agent, "Do work", tmpDir);

    const result = await manager.command(run.id, { action: "stop" });

    expect(launcher.terminatedPid).toBe(process.pid);
    expect(result.status).toBe("stopped");
    expect(manager.get(run.id)?.status).toBe("stopped");
  });

  it("represents an aborted initial turn as an error while keeping the run idle", async () => {
    const run = registry.create({
      agent: "worker",
      agentSource: "project",
      task: "Do work",
      cwd: tmpDir,
    });
    fs.mkdirSync(path.dirname(run.socketPath), { recursive: true });
    const server = net.createServer((socket) => {
      const idle = registry.update(run.id, { status: "idle" });
      socket.end(`${JSON.stringify({ success: true, run: idle })}\n`);
    });
    await new Promise<void>((resolve) => server.listen(run.socketPath, resolve));
    const manager = new AgentRunManager(registry);
    const controller = new AbortController();
    controller.abort();

    const result = await manager.waitForInitialTurn(run.id, controller.signal);

    expect(result.status).toBe("idle");
    expect(result.initialTurnOutcome).toBe("aborted");
    expect(result.errorMessage).toBe("Initial turn was aborted");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("waits for a new settled generation even when the output is unchanged", async () => {
    const run = registry.create({
      agent: "worker",
      agentSource: "project",
      task: "Do work",
      cwd: tmpDir,
    });
    const initial = registry.update(run.id, {
      status: "idle",
      lastAssistantText: "same output",
      settledGeneration: 1,
    });
    fs.mkdirSync(path.dirname(run.socketPath), { recursive: true });
    const server = net.createServer((socket) => {
      socket.setEncoding("utf-8");
      socket.on("data", () => {
        socket.end(`${JSON.stringify({ success: true, run: initial })}\n`);
        setTimeout(
          () =>
            registry.update(run.id, {
              status: "idle",
              lastEvent: "agent_settled",
              lastAssistantText: "same output",
              settledGeneration: 2,
            }),
          10,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(run.socketPath, resolve));
    const manager = new AgentRunManager(registry);

    const result = await manager.command(run.id, { action: "follow_up", message: "Again" });

    expect(result.settledGeneration).toBe(2);
    expect(result.lastAssistantText).toBe("same output");
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
        const settled = registry.update(run.id, {
          status: "idle",
          lastEvent: "agent_settled",
          settledGeneration: 1,
        });
        socket.end(`${JSON.stringify({ success: true, run: settled })}\n`);
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
