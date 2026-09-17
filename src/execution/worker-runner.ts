import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { HermesCliProvider, type HermesRunResult } from "../providers/hermes-cli.js";
import { resolveRoute, ResolverError, type RouteRequest } from "../resolver.js";
import type { BridgeConfig, WorkspaceMode } from "../types.js";
import { compareEvidence, captureGitEvidence, matchesPath } from "./evidence.js";
import { buildWorkerPrompt, TaskContractSchema, type TaskContract } from "./task-contract.js";
import { redactSensitive, type WorkerRunResult } from "./result.js";
import { createWorktree, type WorktreeInfo } from "./worktree.js";

export type WorkerRunRequest = RouteRequest & {
  cwd: string;
  task: TaskContract;
  workspaceMode?: WorkspaceMode | undefined;
  timeoutMs?: number | undefined;
  maxTurns?: number | undefined;
};

export type WorkerProgress = WorkerRunResult["progress"][number];
export type WorkerRunOptions = {
  onProgress?: ((progress: WorkerProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
};

export async function runWorker(
  config: BridgeConfig,
  request: WorkerRunRequest,
  provider?: HermesCliProvider,
  options: WorkerRunOptions = {}
): Promise<WorkerRunResult> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const task = TaskContractSchema.parse(request.task);
  const workspaceMode = request.workspaceMode ?? config.execution.defaultWorkspaceMode;
  const progress: WorkerProgress[] = [];
  const mark = (stage: string, detail?: string): void => {
    const entry: WorkerProgress = { stage, at: new Date().toISOString(), ...(detail ? { detail } : {}) };
    progress.push(entry);
    options.onProgress?.(entry);
  };

  try {
    throwIfAborted(options.signal);
    const sourceCwd = await validateCwd(config, request.cwd);
    mark("validated", "Workspace and task contract accepted.");
    const routeDecision = resolveRoute(config, request);
    const route = routeDecision.selected;
    const executionConfig = configForWorker(config, route.worker);
    mark("routed", `${route.worker} -> ${route.provider ?? "profile default"}/${route.model ?? "profile default"}`);
    const before = await captureGitEvidence(sourceCwd);
    mark("evidence_before", `${before.changedFiles.length} pre-existing dirty path(s).`);
    if (!before.gitRoot) {
      return baseResult(runId, startedAt, task.id, route, executionConfig, request, before, before, {
        status: "blocked",
        workerText: "",
        progress,
        warnings: [before.error ?? "cwd is not a Git repository"],
        errors: ["A worker run requires a Git repository for deterministic evidence."]
      });
    }

    let executionCwd = sourceCwd;
    let worktree: WorktreeInfo | undefined;
    if (workspaceMode === "worktree") {
      if (before.changedFiles.length > 0) {
        return baseResult(runId, startedAt, task.id, route, executionConfig, request, before, before, {
          status: "blocked",
          workerText: "",
          progress,
          warnings: [],
          errors: ["Cannot create an isolated worktree from a dirty source workspace; commit or stash source changes first."]
        });
      }
      throwIfAborted(options.signal);
      const sourceRoot = await realpath(before.gitRoot);
      const subdirectory = relative(sourceRoot, sourceCwd);
      if (subdirectory.startsWith("..") || isAbsolute(subdirectory)) {
        throw new Error("Workspace cwd is not contained by its Git root.");
      }
      worktree = await createWorktree(before.gitRoot, runId, task.id);
      executionCwd = resolve(worktree.path, subdirectory);
      mark("worktree_created", `Isolated worktree prepared at ${executionCwd}.`);
    }
    const executionRequest = { ...request, cwd: executionCwd };

    const prompt = buildWorkerPrompt(task, {
      role: route.role,
      worker: route.worker,
      profile: route.profile,
      currentState: formatCurrentState(before, task.scope.allowedPaths),
      sideEffectPolicy: config.workers[route.worker]?.sideEffectPolicy ?? config.safety.defaultSideEffectPolicy,
      allowWorkerCommits: config.execution.allowWorkerCommits
    });
    const hermes = provider ?? new HermesCliProvider(executionConfig);
    let runtimeResult;
    try {
      throwIfAborted(options.signal);
      mark("worker_started", "Hermes CLI started.");
      runtimeResult = await hermes.run({
        profile: route.profile,
        ...(route.provider ? { provider: route.provider } : {}),
        ...(route.model ? { model: route.model } : {}),
        toolsets: workerToolsets(config, route.worker),
        cwd: executionCwd,
        prompt,
        timeoutMs: request.timeoutMs ?? config.workers[route.worker]?.timeoutMs ?? config.hermes.timeoutMs,
        maxTurns: request.maxTurns ?? config.workers[route.worker]?.maxTurns,
        ...(options.signal ? { signal: options.signal } : {})
      } as Parameters<HermesCliProvider["run"]>[0]);
      mark(runtimeResult.timedOut ? "timed_out" : "worker_finished", `Hermes exit code: ${runtimeResult.exitCode ?? "unknown"}.`);
    } catch (error) {
      const after = await captureGitEvidence(executionCwd, before.head ?? undefined);
      const cancelled = isAbortError(error, options.signal);
      mark("failed", "Hermes invocation failed; post-run evidence was captured.");
      return baseResult(runId, startedAt, task.id, route, executionConfig, executionRequest, before, after, {
        status: cancelled ? "cancelled" : "failed",
        workerText: "",
        progress,
        warnings: [],
        errors: [cancelled ? "Hermes execution was cancelled." : redactSensitive(error instanceof Error ? error.message : String(error))],
        worktree
      });
    }

    const after = await captureGitEvidence(executionCwd, before.head ?? undefined);
    mark("evidence_after", "Post-run Git snapshot captured.");
    const check = compareEvidence(
      before,
      after,
      scopePatterns(after.gitRoot ?? before.gitRoot, executionCwd, task.scope.allowedPaths),
      scopePatterns(after.gitRoot ?? before.gitRoot, executionCwd, task.scope.forbiddenPaths),
      config.execution.allowWorkerCommits,
      config.workers[route.worker]?.sideEffectPolicy ?? config.safety.defaultSideEffectPolicy
    );
    const warnings = [...check.warnings];
    const diagnosticStderr = runtimeResult.stderr.replace(/^session_id:\s*\S+\s*$/gmi, "").trim();
    if (diagnosticStderr) warnings.push(redactSensitive(diagnosticStderr));
    if (runtimeResult.usageWarning) warnings.push(runtimeResult.usageWarning);
    const budgetExhausted = /(?:reached|hit).{0,24}(?:maximum )?(?:iteration|turn)|(?:iteration|turn).{0,24}(?:budget exhausted|limit reached)/i
      .test(`${runtimeResult.stdout}\n${runtimeResult.stderr}`);
    const status = options.signal?.aborted
      ? "cancelled"
      : check.warnings.length > 0
      ? "policy_violation"
      : runtimeResult.timedOut
        ? "timed_out"
        : budgetExhausted
          ? "budget_exhausted"
        : runtimeResult.exitCode === 0
          ? runtimeResult.stdout.trim() ? "completed" : "invalid_result"
          : "failed";
    mark("completed", `Run finished with status ${status}.`);
    return baseResult(runId, startedAt, task.id, route, executionConfig, executionRequest, before, after, {
      status,
      workerText: truncateWorkerReport(redactSensitive(runtimeResult.stdout.trim()), config.execution.maxWorkerReportChars),
      progress,
      warnings,
      errors: options.signal?.aborted
        ? ["Hermes execution was cancelled."]
        : runtimeResult.timedOut
        ? ["Hermes timed out. Inspect evidence.changedFiles for recoverable partial work."]
        : runtimeResult.exitCode !== 0
          ? [`Hermes exited with code ${runtimeResult.exitCode ?? "unknown"}.`]
          : budgetExhausted
            ? ["Hermes exhausted its turn budget. Inspect the partial report and changed files before resuming."]
            : [],
      runtime: runtimeResult,
      worktree
    });
  } catch (error) {
    const message = redactSensitive(error instanceof ResolverError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));
    return {
      schemaVersion: "1.0",
      runId,
      status: isAbortError(error, options.signal)
        ? "cancelled"
        : error instanceof ResolverError ? "routing_failed" : "invalid_result",
      taskId: task.id,
      team: request.team ?? config.routing.defaultTeam,
      worker: request.worker ?? "unknown",
      routing: {
        profile: null,
        modelRef: null,
        provider: null,
        model: null,
        modelSource: "none"
      },
      runtime: {
        kind: config.hermes.runtime,
        distro: config.hermes.distro ?? null,
        exitCode: null,
        timedOut: false,
        sessionId: null
      },
      usage: null,
      workspace: {
        mode: workspaceMode,
        cwd: request.cwd,
        gitRoot: null,
        headBefore: null,
        headAfter: null
      },
      evidence: {
        changedFiles: [],
        diffStat: "",
        statusBefore: [],
        statusAfter: [],
        outOfScopeChanges: []
      },
      workerReport: { text: "" },
      progress,
      warnings: [],
      errors: [isAbortError(error, options.signal) ? "Hermes execution was cancelled." : message],
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}

function baseResult(
  runId: string,
  startedAt: string,
  taskId: string,
  route: ReturnType<typeof resolveRoute>["selected"],
  config: BridgeConfig,
  request: WorkerRunRequest,
  before: Awaited<ReturnType<typeof captureGitEvidence>>,
  after: Awaited<ReturnType<typeof captureGitEvidence>>,
  details: {
    status: WorkerRunResult["status"];
    workerText: string;
    warnings: string[];
    errors: string[];
    progress: WorkerProgress[];
    runtime?: HermesRunResult;
    worktree?: WorktreeInfo | undefined;
  }
): WorkerRunResult {
  const check = compareEvidence(
    before,
    after,
    scopePatterns(after.gitRoot ?? before.gitRoot, request.cwd, request.task.scope.allowedPaths),
    scopePatterns(after.gitRoot ?? before.gitRoot, request.cwd, request.task.scope.forbiddenPaths),
    config.execution.allowWorkerCommits,
    config.workers[route.worker]?.sideEffectPolicy ?? config.safety.defaultSideEffectPolicy
  );
  return {
    schemaVersion: "1.0",
    runId,
    status: details.status,
    taskId,
    team: route.team,
    worker: route.worker,
    routing: {
      profile: route.profile,
      modelRef: route.modelRef,
      provider: route.provider,
      model: route.model,
      modelSource: route.modelSource
    },
    runtime: {
      kind: details.runtime?.runtime ?? config.hermes.runtime,
      distro: (details.runtime?.runtime ?? config.hermes.runtime) === "wsl"
        ? details.runtime?.distro ?? config.hermes.distro ?? null
        : null,
      exitCode: details.runtime?.exitCode ?? null,
      timedOut: details.runtime?.timedOut ?? false,
      sessionId: details.runtime?.sessionId ?? null
    },
    usage: details.runtime?.usage ?? null,
    workspace: {
      mode: request.workspaceMode ?? config.execution.defaultWorkspaceMode,
      cwd: request.cwd,
      gitRoot: after.gitRoot ?? before.gitRoot,
      headBefore: before.head,
      headAfter: after.head,
      ...(details.worktree ? { worktreePath: details.worktree.path, branch: details.worktree.branch } : {})
    },
    evidence: {
      changedFiles: check.changedFiles,
      diffStat: check.diffStat,
      statusBefore: check.statusBefore,
      statusAfter: check.statusAfter,
      outOfScopeChanges: check.outOfScopeChanges
    },
    workerReport: { text: details.workerText },
    progress: details.progress,
    warnings: [...new Set([...details.warnings, ...check.warnings])],
    errors: details.errors.map(redactSensitive),
    startedAt,
    finishedAt: new Date().toISOString()
  };
}

function scopePatterns(gitRoot: string | null, cwd: string, patterns: string[]): string[] {
  if (!gitRoot) return patterns;
  const base = relative(gitRoot, cwd).replaceAll("\\", "/");
  if (!base || base === ".") return patterns;
  return patterns.map((pattern) => {
    if (isAbsolute(pattern) || pattern.startsWith("../") || pattern.startsWith("..\\")) return pattern;
    return `${base}/${pattern.replaceAll("\\", "/")}`;
  });
}

export function blockedWorkerResult(
  config: BridgeConfig,
  request: WorkerRunRequest,
  error: string,
  status: "blocked" | "cancelled" = "blocked"
): WorkerRunResult {
  const startedAt = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    runId: randomUUID(),
    status,
    taskId: request.task.id,
    team: request.team ?? config.routing.defaultTeam,
    worker: request.worker ?? "unknown",
    routing: { profile: null, modelRef: null, provider: null, model: null, modelSource: "none" },
    runtime: { kind: config.hermes.runtime, distro: config.hermes.distro ?? null, exitCode: null, timedOut: false, sessionId: null },
    usage: null,
    workspace: { mode: request.workspaceMode ?? config.execution.defaultWorkspaceMode, cwd: request.cwd, gitRoot: null, headBefore: null, headAfter: null },
    evidence: { changedFiles: [], diffStat: "", statusBefore: [], statusAfter: [], outOfScopeChanges: [] },
    workerReport: { text: "" },
    progress: [],
    warnings: [],
    errors: [error],
    startedAt,
    finishedAt: new Date().toISOString()
  };
}

async function validateCwd(config: BridgeConfig, cwd: string): Promise<string> {
  const absolute = resolve(cwd);
  let actual: string;
  try {
    actual = await realpath(absolute);
  } catch {
    throw new Error(`Workspace cwd is not an existing directory: ${cwd}`);
  }
  if (!statSync(actual).isDirectory()) throw new Error(`Workspace cwd is not an existing directory: ${cwd}`);
  if (config.safety.allowedWorkspaceRoots.length === 0) return actual;
  const roots = await Promise.all(config.safety.allowedWorkspaceRoots.map(async (root) => {
    try {
      return await realpath(resolve(root));
    } catch {
      return null;
    }
  }));
  const allowed = roots.some((root) => {
    if (!root) return false;
    const relativePath = relative(root, actual);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  });
  if (!allowed) throw new Error(`Workspace cwd is outside configured allowedWorkspaceRoots: ${cwd}`);
  return actual;
}

function workerToolsets(config: BridgeConfig, workerName: string): string[] {
  const worker = config.workers[workerName];
  return worker && worker.toolsets.length > 0 ? worker.toolsets : config.hermes.defaultToolsets;
}

function formatCurrentState(
  state: Awaited<ReturnType<typeof captureGitEvidence>>,
  allowedPaths: string[]
): string {
  const scoped = state.changedFiles.filter((file) => allowedPaths.some((pattern) => matchesPath(file, pattern)));
  return [
    `Git root: ${state.gitRoot ?? "unknown"}`,
    `HEAD: ${state.head ?? "unknown"}`,
    `Pre-existing dirty paths: ${state.changedFiles.length}`,
    `Pre-existing dirty paths in task scope: ${scoped.length > 0 ? scoped.join(", ") : "none"}`
  ].join("\n");
}

function configForWorker(config: BridgeConfig, workerName: string): BridgeConfig {
  const worker = config.workers[workerName];
  if (!worker || (!worker.runtime && !worker.command && !worker.distro)) return config;
  return {
    ...config,
    hermes: {
      ...config.hermes,
      ...(worker.runtime ? { runtime: worker.runtime } : {}),
      ...(worker.command ? { command: worker.command } : {}),
      ...(worker.distro ? { distro: worker.distro } : {})
    }
  };
}

export function truncateWorkerReport(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const removed = text.length - maxChars;
  return `[... ${removed} earlier characters omitted ...]\n${text.slice(-maxChars)}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    throw error;
  }
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}
