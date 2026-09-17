import { randomUUID } from "node:crypto";
import { getTeam, getWorker } from "../registry.js";
import { HermesCliProvider } from "../providers/hermes-cli.js";
import { resolveRoute } from "../resolver.js";
import type { BridgeConfig, WorkspaceMode } from "../types.js";
import { blockedWorkerResult, runWorker, type WorkerProgress, type WorkerRunRequest } from "./worker-runner.js";
import { isWritePolicy } from "./worktree.js";
import { redactSensitive, type WorkerRunResult } from "./result.js";

export type TeamTaskRequest = Omit<WorkerRunRequest, "task" | "cwd" | "workspaceMode"> & {
  id: string;
  cwd: string;
  task: WorkerRunRequest["task"];
  workspaceMode?: WorkspaceMode | undefined;
};

export type TeamRunRequest = {
  team: string;
  mode: "parallel";
  tasks: TeamTaskRequest[];
  maxParallel?: number | undefined;
};

export type TeamRunOptions = {
  onProgress?: ((taskId: string, progress: WorkerProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
};

export type TeamRunResult = {
  schemaVersion: "1.0";
  runId: string;
  status: "completed" | "partial" | "failed";
  team: string;
  mode: "parallel";
  maxParallel: number;
  results: WorkerRunResult[];
  usage: TeamUsage;
  warnings: string[];
  errors: string[];
};

export type TeamUsage = {
  measuredWorkers: number;
  totalWorkers: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  apiCalls: number;
  toolCalls: number;
};

export async function runTeam(
  config: BridgeConfig,
  request: TeamRunRequest,
  provider?: HermesCliProvider,
  options: TeamRunOptions = {}
): Promise<TeamRunResult> {
  const runId = randomUUID();
  const warnings: string[] = [];
  const errors: string[] = [];
  const ids = request.tasks.map((task) => task.id);
  const invalidIdIndex = ids.findIndex((id) => typeof id !== "string" || id.trim() === "");
  if (invalidIdIndex >= 0) {
    return {
      schemaVersion: "1.0",
      runId,
      status: "failed",
      team: request.team,
      mode: request.mode,
      maxParallel: 0,
      results: [],
      usage: summarizeUsage([]),
      warnings: [],
      errors: [`Task at index ${invalidIdIndex} is missing a non-empty top-level id.`]
    };
  }
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    return {
      schemaVersion: "1.0",
      runId,
      status: "failed",
      team: request.team,
      mode: request.mode,
      maxParallel: 0,
      results: [],
      usage: summarizeUsage([]),
      warnings: [],
      errors: [`Duplicate task IDs: ${[...new Set(duplicateIds)].join(", ")}`]
    };
  }
  if (request.tasks.some((task) => (task.task.dependsOn?.length ?? 0) > 0)) {
    return {
      schemaVersion: "1.0",
      runId,
      status: "failed",
      team: request.team,
      mode: request.mode,
      maxParallel: 0,
      results: [],
      usage: summarizeUsage([]),
      warnings: [],
      errors: ["Parallel team tasks with dependsOn are unsupported; submit independent tasks or run them sequentially."]
    };
  }

  const configuredTeam = getTeam(config, request.team);
  const teamLimit = configuredTeam?.maxParallel ?? config.execution.maxParallel;
  const maxParallel = Math.max(1, Math.min(config.execution.maxParallel, teamLimit, request.maxParallel ?? Number.MAX_SAFE_INTEGER));
  const results = new Array<WorkerRunResult>(request.tasks.length);
  let nextIndex = 0;
  let failureSeen = false;
  const workerCount = Math.min(maxParallel, Math.max(1, request.tasks.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        const task = request.tasks[index];
        if (!task) return;
        if (options.signal?.aborted) {
          results[index] = blockedWorkerResult(config, task, "Task was not started because execution was cancelled.", "cancelled");
          continue;
        }
        if (failureSeen) {
          results[index] = blockedWorkerResult(config, task, "Task was not started because failFast stopped queued work after another task failed.");
          continue;
        }
        try {
          results[index] = await runTeamTask(config, request.team, runId, task, warnings, provider, options);
          if (config.execution.failFast && results[index].status !== "completed") failureSeen = true;
        } catch (error) {
          results[index] = failedWorkerResult(config, request.team, task, error);
          if (config.execution.failFast) failureSeen = true;
        }
      }
    })
  );

  const completed = results.filter((result) => result.status === "completed").length;
  const failed = results.length - completed;
  if (failed > 0) errors.push(`${failed} of ${results.length} team task(s) did not complete.`);
  return {
    schemaVersion: "1.0",
    runId,
    status: failed === 0 ? "completed" : completed > 0 ? "partial" : "failed",
    team: request.team,
    mode: request.mode,
    maxParallel,
    results,
    usage: summarizeUsage(results),
    warnings: [...new Set(warnings)],
    errors
  };
}

function summarizeUsage(results: WorkerRunResult[]): TeamUsage {
  const usage = results.flatMap((result) => result.usage ? [result.usage] : []);
  return usage.reduce<TeamUsage>((total, item) => ({
    measuredWorkers: total.measuredWorkers + 1,
    totalWorkers: results.length,
    inputTokens: total.inputTokens + item.inputTokens,
    cacheReadTokens: total.cacheReadTokens + item.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + item.cacheWriteTokens,
    outputTokens: total.outputTokens + item.outputTokens,
    reasoningTokens: total.reasoningTokens + item.reasoningTokens,
    totalTokens: total.totalTokens + item.totalTokens,
    apiCalls: total.apiCalls + item.apiCalls,
    toolCalls: total.toolCalls + item.toolCalls
  }), {
    measuredWorkers: 0,
    totalWorkers: results.length,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    apiCalls: 0,
    toolCalls: 0
  });
}

async function runTeamTask(
  config: BridgeConfig,
  teamName: string,
  runId: string,
  task: TeamTaskRequest,
  warnings: string[],
  provider?: HermesCliProvider,
  options: TeamRunOptions = {}
): Promise<WorkerRunResult> {
  const route = resolveRoute(config, {
    team: teamName,
    worker: task.worker,
    role: task.role,
    capabilities: task.capabilities,
    modelOverride: task.modelOverride
  });
  const worker = getWorker(config, route.selected.worker);
  const policy = worker?.sideEffectPolicy ?? config.safety.defaultSideEffectPolicy;
  const wantsWrite = isWritePolicy(policy);
  const requestedMode = task.workspaceMode;
  const mode = requestedMode ?? (wantsWrite ? config.execution.parallelWriteWorkspaceMode : "shared");
  if (mode === "shared" && wantsWrite && config.execution.parallelWriteWorkspaceMode === "worktree") {
    warnings.push(`Task '${task.id}' explicitly uses shared workspace for a write-capable worker.`);
  }

  const result = await runWorker(config, {
    ...task,
    team: teamName,
    worker: route.selected.worker,
    workspaceMode: mode
  }, provider, {
    signal: options.signal,
    onProgress: (progress) => options.onProgress?.(task.id, progress)
  });
  return result;
}

function failedWorkerResult(
  config: BridgeConfig,
  team: string,
  task: TeamTaskRequest,
  error: unknown
): WorkerRunResult {
  return {
    schemaVersion: "1.0",
    runId: randomUUID(),
    status: "failed",
    taskId: task.id,
    team,
    worker: task.worker ?? "unknown",
    routing: { profile: null, modelRef: null, provider: null, model: null, modelSource: "none" },
    runtime: { kind: config.hermes.runtime, distro: config.hermes.distro ?? null, exitCode: null, timedOut: false, sessionId: null },
    usage: null,
    workspace: { mode: task.workspaceMode ?? "shared", cwd: task.cwd, gitRoot: null, headBefore: null, headAfter: null },
    evidence: { changedFiles: [], diffStat: "", statusBefore: [], statusAfter: [], outOfScopeChanges: [] },
    workerReport: { text: "" },
    progress: [],
    warnings: [],
    errors: [redactSensitive(error instanceof Error ? error.message : String(error))],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString()
  };
}
