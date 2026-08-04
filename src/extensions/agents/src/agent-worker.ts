import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { AgentWorkerLaunchConfig } from "./agent-run-manager.js";
import { AgentRunRegistry, type AgentRunRecord } from "./agent-run-registry.js";

interface RpcResponse {
  type: "response";
  id?: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

interface WorkerCommand {
  action: "message" | "steer" | "follow_up" | "abort" | "stop";
  message?: string;
}

interface WorkerResponse {
  success: boolean;
  error?: string;
  run?: AgentRunRecord;
}

function isLaunchConfig(value: unknown): value is AgentWorkerLaunchConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.runId === "string" &&
    typeof config.agentName === "string" &&
    typeof config.task === "string" &&
    typeof config.cwd === "string" &&
    typeof config.registryDir === "string" &&
    typeof config.sessionDir === "string"
  );
}

function isRpcResponse(value: unknown): value is RpcResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  return response.type === "response" && typeof response.success === "boolean";
}

function isWorkerCommand(value: unknown): value is WorkerCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  return (
    command.action === "message" ||
    command.action === "steer" ||
    command.action === "follow_up" ||
    command.action === "abort" ||
    command.action === "stop"
  );
}

function getText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
  return text || undefined;
}

class RpcTransport {
  private readonly pending = new Map<
    string,
    { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
  >();
  private nextId = 0;
  private buffer = "";

  constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly onEvent: (event: Record<string, unknown>) => void,
  ) {
    process.stdout.setEncoding("utf-8");
    process.stdout.on("data", (chunk: string) => this.processChunk(chunk));
    process.on("close", () => {
      for (const request of this.pending.values()) {
        request.reject(new Error("Pi RPC process exited"));
      }
      this.pending.clear();
    });
  }

  request(command: Record<string, unknown>): Promise<RpcResponse> {
    const id = `worker-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private processChunk(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const event = value as Record<string, unknown>;
      if (isRpcResponse(event) && event.id) {
        const pending = this.pending.get(event.id);
        if (pending) {
          this.pending.delete(event.id);
          pending.resolve(event);
        }
        continue;
      }
      this.onEvent(event);
    }
  }
}

class AgentWorker {
  private readonly registry: AgentRunRegistry;
  private readonly rpcProcess: ChildProcessWithoutNullStreams;
  private readonly transport: RpcTransport;
  private readonly server: net.Server;
  private stopping = false;
  private failure: string | null = null;
  private lastPersistedAt = 0;

  constructor(private readonly config: AgentWorkerLaunchConfig) {
    this.registry = new AgentRunRegistry(config.registryDir);
    fs.mkdirSync(config.sessionDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(this.registry.getSocketPath(config.runId)), {
      recursive: true,
      mode: 0o700,
    });

    this.rpcProcess = spawn(
      "pi",
      [
        "--mode",
        "rpc",
        "--session-dir",
        config.sessionDir,
        "--name",
        `agent:${config.agentName}:${config.runId.slice(0, 8)}`,
        "--agent",
        config.agentName,
        "--approve",
      ],
      {
        cwd: config.cwd,
        env: {
          ...process.env,
          PI_AGENT_RUN_ID: config.runId,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.transport = new RpcTransport(this.rpcProcess, (event) => this.handleRpcEvent(event));
    this.server = net.createServer((socket) => this.handleClient(socket));
  }

  async start(): Promise<void> {
    const socketPath = this.registry.getSocketPath(this.config.runId);
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // No stale socket was present.
    }

    this.rpcProcess.once("error", (error) => this.fail(error));
    this.rpcProcess.stderr.setEncoding("utf-8");
    this.rpcProcess.stderr.on("data", (chunk: string) => {
      const detail = chunk.trim();
      if (detail) this.persist({ statusDetail: detail.slice(-1000), lastEvent: "stderr" }, true);
    });
    this.rpcProcess.on("close", (code, signal) => {
      const expected = this.stopping;
      this.persist(
        expected
          ? { status: "stopped", lastEvent: "process_exit" }
          : {
              status: "failed",
              error: this.failure ?? `Pi RPC process exited (${signal ?? code ?? "unknown"})`,
              lastEvent: "process_exit",
            },
        true,
      );
      if (this.server.listening) this.server.close();
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Socket was already gone.
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(socketPath, () => {
        fs.chmodSync(socketPath, 0o600);
        resolve();
      });
    });

    this.persist(
      {
        pid: process.pid,
        rpcPid: this.rpcProcess.pid,
        socketPath,
        lastEvent: "worker_ready",
      },
      true,
    );
    const response = await this.transport.request({ type: "prompt", message: this.config.task });
    if (!response.success) throw new Error(response.error ?? "Initial prompt was rejected");
  }

  fail(error: unknown): void {
    this.failure = error instanceof Error ? error.message : String(error);
    this.persist(
      {
        status: "failed",
        error: this.failure,
        lastEvent: "worker_start_failed",
      },
      true,
    );
    this.rpcProcess.kill("SIGTERM");
    if (this.server.listening) this.server.close();
    try {
      fs.unlinkSync(this.registry.getSocketPath(this.config.runId));
    } catch {
      // Socket was not created or was already removed.
    }
  }

  private handleRpcEvent(event: Record<string, unknown>): void {
    const type = typeof event.type === "string" ? event.type : "unknown";
    if (type === "agent_start") {
      this.registry.clearReport(this.config.runId);
      this.persist({ status: "working", lastEvent: type, statusDetail: undefined }, true);
      return;
    }
    if (type === "agent_settled") {
      this.persist({ status: "idle", lastEvent: type }, true);
      void this.refreshState();
      return;
    }
    if (type === "tool_execution_start") {
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      this.persist({ lastEvent: type, statusDetail: `Using ${toolName}` });
      return;
    }
    if (type === "message_end") {
      const text = getText(event.message);
      this.persist({ lastEvent: type, ...(text ? { lastAssistantText: text } : {}) }, true);
      return;
    }
    this.persist({ lastEvent: type });
  }

  private async refreshState(): Promise<void> {
    try {
      const response = await this.transport.request({ type: "get_state" });
      if (!response.success || !response.data || typeof response.data !== "object") return;
      const state = response.data as Record<string, unknown>;
      this.persist(
        {
          ...(typeof state.sessionFile === "string" ? { sessionFile: state.sessionFile } : {}),
          ...(state.model && typeof state.model === "object"
            ? {
                model: `${String((state.model as Record<string, unknown>).provider)}/${String((state.model as Record<string, unknown>).id)}`,
              }
            : {}),
        },
        true,
      );
    } catch {
      // The lifecycle record remains useful without session enrichment.
    }
  }

  private handleClient(socket: net.Socket): void {
    socket.setEncoding("utf-8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let value: unknown;
      try {
        value = JSON.parse(buffer.slice(0, newline));
      } catch {
        this.respond(socket, { success: false, error: "Invalid JSON command" });
        return;
      }
      if (!isWorkerCommand(value)) {
        this.respond(socket, { success: false, error: "Invalid agent run command" });
        return;
      }
      void this.execute(value)
        .then((run) => this.respond(socket, { success: true, run }))
        .catch((error: unknown) =>
          this.respond(socket, {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    });
  }

  private async execute(command: WorkerCommand): Promise<AgentRunRecord> {
    if (command.action === "stop") {
      this.stopping = true;
      this.persist({ status: "stopping", lastEvent: "stop_requested" }, true);
      await this.transport.request({ type: "abort" });
      this.rpcProcess.kill("SIGTERM");
      return this.registry.get(this.config.runId) ?? this.persist({ status: "stopping" }, true);
    }

    const rpcCommand: Record<string, unknown> = { type: command.action };
    if (command.action === "message") rpcCommand.type = "prompt";
    if (command.message) rpcCommand.message = command.message;
    const response = await this.transport.request(rpcCommand);
    if (!response.success) throw new Error(response.error ?? `RPC ${command.action} failed`);
    return this.registry.get(this.config.runId) ?? this.persist({}, true);
  }

  private respond(socket: net.Socket, response: WorkerResponse): void {
    socket.end(`${JSON.stringify(response)}\n`);
  }

  private persist(patch: Partial<AgentRunRecord>, force = false): AgentRunRecord {
    const now = Date.now();
    if (!force && now - this.lastPersistedAt < 250) {
      return this.registry.get(this.config.runId) ?? this.registry.update(this.config.runId, patch);
    }
    this.lastPersistedAt = now;
    return this.registry.update(this.config.runId, {
      ...patch,
      lastActivityAt: new Date(now).toISOString(),
    });
  }
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Agent worker launch config path is required");
  const value: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  fs.unlinkSync(configPath);
  if (!isLaunchConfig(value)) throw new Error("Invalid agent worker launch config");
  const worker = new AgentWorker(value);
  try {
    await worker.start();
  } catch (error: unknown) {
    worker.fail(error);
    throw error;
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
