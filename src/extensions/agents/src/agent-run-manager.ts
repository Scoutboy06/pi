import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "./agent-loader.js";
import { AgentRunRegistry, type AgentRunRecord } from "./agent-run-registry.js";

const COMMAND_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 5_000;

export type AgentRunCommandAction = "message" | "steer" | "follow_up" | "abort" | "stop";

export interface AgentRunCommand {
  action: AgentRunCommandAction;
  message?: string;
}

export interface AgentWorkerLaunchConfig {
  runId: string;
  agentName: string;
  task: string;
  cwd: string;
  registryDir: string;
  sessionDir: string;
}

export interface AgentRunEventSink {
  emit(channel: string, data: unknown): void;
}

export interface AgentWorkerLauncher {
  launch(configPath: string, environment: NodeJS.ProcessEnv): number | undefined;
}

class BunAgentWorkerLauncher implements AgentWorkerLauncher {
  launch(configPath: string, environment: NodeJS.ProcessEnv): number | undefined {
    const bun = process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, "bin", "bun") : "bun";
    const workerPath = fileURLToPath(new URL("agent-worker.ts", import.meta.url));
    const child = spawn(bun, [workerPath, configPath], {
      detached: true,
      env: environment,
      stdio: "ignore",
    });
    child.once("error", () => {
      // A missing runtime is reflected by the absent pid and failed run record.
    });
    child.unref();
    return child.pid;
  }
}

interface WorkerResponse {
  success: boolean;
  error?: string;
  run?: AgentRunRecord;
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!value || typeof value !== "object") return false;
  return typeof (value as Record<string, unknown>).success === "boolean";
}

export class AgentRunManager {
  private watcher: fs.FSWatcher | null = null;

  constructor(
    readonly registry = new AgentRunRegistry(),
    private readonly launcher: AgentWorkerLauncher = new BunAgentWorkerLauncher(),
    private readonly eventSink?: AgentRunEventSink,
  ) {}

  async start(
    agent: AgentConfig,
    task: string,
    cwd: string,
    tags: string[] = [],
  ): Promise<AgentRunRecord> {
    const parentRunId = process.env.PI_AGENT_RUN_ID;
    const record = this.registry.create({
      agent: agent.name,
      agentSource: agent.source,
      task,
      cwd,
      tags,
      ...(parentRunId ? { parentRunId } : {}),
    });
    const launch: AgentWorkerLaunchConfig = {
      runId: record.id,
      agentName: agent.name,
      task,
      cwd: record.cwd,
      registryDir: this.registry.baseDir,
      sessionDir: this.registry.getSessionDir(),
    };
    const configPath = this.registry.writeLaunchConfig(record.id, launch);
    const pid = this.launcher.launch(configPath, {
      ...process.env,
      PI_AGENT_RUN_ID: record.id,
      ...(parentRunId ? { PI_AGENT_PARENT_RUN_ID: parentRunId } : {}),
    });

    if (!pid) {
      try {
        fs.unlinkSync(configPath);
      } catch {
        // Worker may have consumed the launch file before failing.
      }
      const failed = this.registry.update(record.id, {
        status: "failed",
        error: "Failed to start agent worker",
      });
      this.emit(failed);
      return failed;
    }

    const starting = this.registry.update(record.id, { pid });
    this.emit(starting);
    return this.waitUntilReady(starting.id);
  }

  list(): AgentRunRecord[] {
    return this.registry.list();
  }

  get(id: string): AgentRunRecord | null {
    return this.registry.get(id);
  }

  async command(id: string, command: AgentRunCommand): Promise<AgentRunRecord> {
    const run = this.registry.get(id);
    if (!run) throw new Error(`Unknown agent run: ${id}`);
    const response = await this.send(run.socketPath, command);
    if (!response.success)
      throw new Error(response.error ?? `Agent run command failed: ${command.action}`);
    const updated = response.run ?? this.registry.get(id);
    if (!updated) throw new Error(`Agent run disappeared: ${id}`);
    this.emit(updated);
    return updated;
  }

  watch(): void {
    if (this.watcher) return;
    fs.mkdirSync(this.registry.baseDir, { recursive: true, mode: 0o700 });
    this.watcher = fs.watch(this.registry.baseDir, { persistent: false }, (_event, fileName) => {
      if (!fileName?.endsWith(".run.json") && !fileName?.endsWith(".status.json")) return;
      const id = fileName.replace(/\.(run|status)\.json$/, "");
      const run = this.registry.get(id);
      if (run) this.emit(run);
    });
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private emit(run: AgentRunRecord): void {
    this.eventSink?.emit("agents:run-updated", run);
  }

  private async waitUntilReady(id: string): Promise<AgentRunRecord> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const run = this.registry.get(id);
      if (!run) throw new Error(`Agent run disappeared during startup: ${id}`);
      if (run.status === "failed") return run;
      if (fs.existsSync(run.socketPath)) return run;
      await Bun.sleep(50);
    }
    return this.registry.update(id, {
      status: "failed",
      error: "Agent worker startup timed out",
    });
  }

  private send(socketPath: string, command: AgentRunCommand): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = "";
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out contacting agent worker at ${socketPath}`));
      }, COMMAND_TIMEOUT_MS);

      socket.setEncoding("utf-8");
      socket.on("connect", () => socket.write(`${JSON.stringify(command)}\n`));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timeout);
        socket.end();
        let value: unknown;
        try {
          value = JSON.parse(buffer.slice(0, newline));
        } catch {
          reject(new Error("Agent worker returned invalid JSON"));
          return;
        }
        if (!isWorkerResponse(value)) {
          reject(new Error("Agent worker returned an invalid response"));
          return;
        }
        resolve(value);
      });
      socket.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}
