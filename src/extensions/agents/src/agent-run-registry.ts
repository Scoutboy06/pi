import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type AgentRunLifecycle = "starting" | "working" | "idle" | "stopping" | "stopped" | "failed";
export type AgentReportedStatus = "working" | "paused" | "blocked";
export type AgentRunStatus = AgentRunLifecycle | "paused" | "blocked";

export interface AgentRunRecord {
  version: 1;
  id: string;
  agent: string;
  agentSource: string;
  task: string;
  cwd: string;
  parentRunId?: string;
  tags: string[];
  status: AgentRunStatus;
  statusDetail?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  lastEvent?: string;
  lastAssistantText?: string;
  model?: string;
  pid?: number;
  rpcPid?: number;
  socketPath: string;
  sessionFile?: string;
  error?: string;
}

interface ReportedStatusRecord {
  status: AgentReportedStatus;
  detail?: string;
  updatedAt: string;
}

export interface CreateAgentRunInput {
  agent: string;
  agentSource: string;
  task: string;
  cwd: string;
  parentRunId?: string;
  tags?: string[];
}

function isAgentRunRecord(value: unknown): value is AgentRunRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.id === "string" &&
    typeof record.agent === "string" &&
    typeof record.task === "string" &&
    typeof record.cwd === "string" &&
    typeof record.status === "string" &&
    typeof record.socketPath === "string"
  );
}

function isReportedStatusRecord(value: unknown): value is ReportedStatusRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (record.status === "working" || record.status === "paused" || record.status === "blocked") &&
    typeof record.updatedAt === "string"
  );
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

function isActiveStatus(status: AgentRunStatus): boolean {
  return status === "starting" || status === "working" || status === "idle";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return Boolean(error && typeof error === "object" && Reflect.get(error, "code") === "EPERM");
  }
}

export class AgentRunRegistry {
  readonly baseDir: string;

  constructor(baseDir = path.join(getAgentDir(), "agent-runs")) {
    this.baseDir = baseDir;
  }

  create(input: CreateAgentRunInput): AgentRunRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: AgentRunRecord = {
      version: 1,
      id,
      agent: input.agent,
      agentSource: input.agentSource,
      task: input.task,
      cwd: path.resolve(input.cwd),
      tags: input.tags ?? [],
      status: "starting",
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      socketPath: this.getSocketPath(id),
    };
    if (input.parentRunId) record.parentRunId = input.parentRunId;
    this.write(record);
    return record;
  }

  get(id: string): AgentRunRecord | null {
    const value = readJson(this.getRecordPath(id));
    if (!isAgentRunRecord(value)) return null;
    return this.mergeReportedStatus(value);
  }

  list(): AgentRunRecord[] {
    if (!fs.existsSync(this.baseDir)) return [];
    return fs
      .readdirSync(this.baseDir)
      .filter((name) => name.endsWith(".run.json"))
      .map((name) => this.get(name.slice(0, -".run.json".length)))
      .filter((record): record is AgentRunRecord => record !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  update(id: string, patch: Partial<AgentRunRecord>): AgentRunRecord {
    const currentValue = readJson(this.getRecordPath(id));
    if (!isAgentRunRecord(currentValue)) throw new Error(`Unknown agent run: ${id}`);
    const updated: AgentRunRecord = {
      ...currentValue,
      ...patch,
      id: currentValue.id,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    this.write(updated);
    return this.mergeReportedStatus(updated);
  }

  report(id: string, status: AgentReportedStatus, detail?: string): AgentRunRecord {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown agent run: ${id}`);
    if (status === "working") {
      this.clearReport(id);
      return this.get(id) ?? current;
    }
    const reported: ReportedStatusRecord = {
      status,
      updatedAt: new Date().toISOString(),
    };
    if (detail?.trim()) reported.detail = detail.trim();
    writeJsonAtomic(this.getStatusPath(id), reported);
    return this.get(id) ?? current;
  }

  clearReport(id: string): void {
    try {
      fs.unlinkSync(this.getStatusPath(id));
    } catch {
      // No explicit status was present.
    }
  }

  writeLaunchConfig(id: string, config: unknown): string {
    const configPath = this.getLaunchPath(id);
    writeJsonAtomic(configPath, config);
    return configPath;
  }

  getRecordPath(id: string): string {
    return path.join(this.baseDir, `${id}.run.json`);
  }

  getStatusPath(id: string): string {
    return path.join(this.baseDir, `${id}.status.json`);
  }

  getLaunchPath(id: string): string {
    return path.join(this.baseDir, `${id}.launch.json`);
  }

  getSocketPath(id: string): string {
    return path.join(this.baseDir, "sockets", `${id}.sock`);
  }

  getSessionDir(): string {
    return path.join(this.baseDir, "sessions");
  }

  private write(record: AgentRunRecord): void {
    writeJsonAtomic(this.getRecordPath(record.id), record);
  }

  private mergeReportedStatus(record: AgentRunRecord): AgentRunRecord {
    if (!isActiveStatus(record.status)) return record;
    if (record.pid && !isProcessAlive(record.pid)) {
      return {
        ...record,
        status: "stopped",
        statusDetail: "Worker process is not running",
      };
    }
    const value = readJson(this.getStatusPath(record.id));
    if (!isReportedStatusRecord(value)) return record;
    const merged: AgentRunRecord = {
      ...record,
      status: value.status,
      updatedAt: value.updatedAt > record.updatedAt ? value.updatedAt : record.updatedAt,
    };
    if (value.detail) merged.statusDetail = value.detail;
    return merged;
  }
}
