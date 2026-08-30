import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { HermesCliProvider, type HermesRunResult } from "../providers/hermes-cli.js";
import { resolveRoute, ResolverError, type RouteRequest } from "../resolver.js";
import type { BridgeConfig, WorkspaceMode } from "../types.js";
import { compareEvidence, captureGitEvidence, type GitEvidence } from "./evidence.js";
import { buildWorkerPrompt, TaskContractSchema, type TaskContract } from "./task-contract.js";
import { redactSensitive, type WorkerRunResult } from "./result.js";

export type WorkerRunRequest = RouteRequest & {
  cwd: string;
  task: TaskContract;
  workspaceMode?: WorkspaceMode | undefined;
  timeoutMs?: number | undefined;
};

export async function runWorker(
  config: BridgeConfig,
  request: WorkerRunRequest,
  provider?: HermesCliProvider
): Promise<WorkerRunResult> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const task = TaskContractSchema.parse(request.task);
  const workspaceMode = request.workspaceMode ?? config.execution.defaultWorkspaceMode;

  try {
    if (workspaceMode === "worktree") {
      return blockedResult(
        runId,
        startedAt,
        task.id,
        request.cwd,
        workspaceMode,
        "Worktree execution is enabled in the parallel team phase."
      );
    }
    validateCwd(config, request.cwd);
    const routeDecision = resolveRoute(config, request);
    const route = routeDecision.selected;
    const before = config.execution.collectGitEvidence
      ? await captureGitEvidence(request.cwd)
      : emptyEvidence();
    if (!before.gitRoot) {
      return baseResult(runId, startedAt, task.id, route, config, request, before, before, {
        status: "blocked",
        workerText: "",
        warnings: [before.error ?? "cwd is not a Git repository"],
        errors: ["A worker run requires a Git repository for deterministic evidence."]
      });
    }

    const prompt = buildWorkerPrompt(task, {
      role: route.role,
      worker: route.worker,
      profile: route.profile,
      currentState: formatCurrentState(before)
    });
    const hermes = provider ?? new HermesCliProvider(config);
    let runtimeResult;
    try {
      runtimeResult = await hermes.run({
        profile: route.profile,
        ...(route.provider ? { provider: route.provider } : {}),
        ...(route.model ? { model: route.model } : {}),
        toolsets: workerToolsets(config, route.worker),
        cwd: request.cwd,
        prompt,
        timeoutMs: request.timeoutMs ?? config.workers[route.worker]?.timeoutMs ?? config.hermes.timeoutMs,
        maxTurns: config.workers[route.worker]?.maxTurns
      });
    } catch (error) {
      const after = config.execution.collectGitEvidence
        ? await captureGitEvidence(request.cwd, before.head ?? undefined)
        : emptyEvidence();
      return baseResult(runId, startedAt, task.id, route, config, request, before, after, {
        status: "failed",
        workerText: "",
        warnings: [],
        errors: [redactSensitive(error instanceof Error ? error.message : String(error))]
      });
    }

    const after = config.execution.collectGitEvidence
      ? await captureGitEvidence(request.cwd, before.head ?? undefined)
      : emptyEvidence();
    const check = compareEvidence(
      before,
      after,
      task.scope.allowedPaths,
      task.scope.forbiddenPaths,
      config.execution.allowWorkerCommits,
      config.workers[route.worker]?.sideEffectPolicy ?? config.safety.defaultSideEffectPolicy
    );
    const warnings = [...check.warnings];
    const diagnosticStderr = runtimeResult.stderr.replace(/^session_id:\s*\S+\s*$/gmi, "").trim();
    if (diagnosticStderr) warnings.push(redactSensitive(diagnosticStderr));
    if (runtimeResult.usageWarning) warnings.push(runtimeResult.usageWarning);
    const status = check.warnings.length > 0
      ? "policy_violation"
      : runtimeResult.timedOut
        ? "timed_out"
        : runtimeResult.exitCode === 0
          ? runtimeResult.stdout.trim() ? "completed" : "invalid_result"
          : "failed";
    return baseResult(runId, startedAt, task.id, route, config, request, before, after, {
      status,
      workerText: redactSensitive(runtimeResult.stdout.trim()),
      warnings,
      errors: runtimeResult.exitCode !== 0 && !runtimeResult.timedOut
        ? [`Hermes exited with code ${runtimeResult.exitCode ?? "unknown"}.`]
        : [],
      runtime: runtimeResult
    });
  } catch (error) {
    const message = redactSensitive(error instanceof ResolverError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));
    return {
      schemaVersion: "1.0",
      runId,
      status: error instanceof ResolverError ? "routing_failed" : "invalid_result",
      taskId: task.id,
      team: request.team ?? config.routing.defaultTeam,
      worker: request.worker ?? "",
      routing: {
        profile: "",
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
      warnings: [],
      errors: [message],
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
    runtime?: HermesRunResult;
  }
): WorkerRunResult {
  const check = compareEvidence(
    before,
    after,
    request.task.scope.allowedPaths,
    request.task.scope.forbiddenPaths,
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
      distro: details.runtime?.distro ?? config.hermes.distro ?? null,
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
      headAfter: after.head
    },
    evidence: {
      changedFiles: check.changedFiles,
      diffStat: check.diffStat,
      statusBefore: check.statusBefore,
      statusAfter: check.statusAfter,
      outOfScopeChanges: check.outOfScopeChanges
    },
    workerReport: { text: details.workerText },
    warnings: [...new Set([...details.warnings, ...check.warnings])],
    errors: details.errors.map(redactSensitive),
    startedAt,
    finishedAt: new Date().toISOString()
  };
}

function blockedResult(
  runId: string,
  startedAt: string,
  taskId: string,
  cwd: string,
  mode: WorkspaceMode,
  error: string
): WorkerRunResult {
  return {
    schemaVersion: "1.0",
    runId,
    status: "blocked",
    taskId,
    team: "unknown",
    worker: "unknown",
    routing: { profile: "", modelRef: null, provider: null, model: null, modelSource: "none" },
    runtime: { kind: "direct", distro: null, exitCode: null, timedOut: false, sessionId: null },
    usage: null,
    workspace: { mode, cwd, gitRoot: null, headBefore: null, headAfter: null },
    evidence: { changedFiles: [], diffStat: "", statusBefore: [], statusAfter: [], outOfScopeChanges: [] },
    workerReport: { text: "" },
    warnings: [],
    errors: [error],
    startedAt,
    finishedAt: new Date().toISOString()
  };
}

function validateCwd(config: BridgeConfig, cwd: string): void {
  const absolute = resolve(cwd);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new Error(`Workspace cwd is not an existing directory: ${cwd}`);
  }
  if (config.safety.allowedWorkspaceRoots.length === 0) return;
  const allowed = config.safety.allowedWorkspaceRoots.some((root) => {
    const relativePath = relative(resolve(root), absolute);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  });
  if (!allowed) throw new Error(`Workspace cwd is outside configured allowedWorkspaceRoots: ${cwd}`);
}

function workerToolsets(config: BridgeConfig, workerName: string): string[] {
  const worker = config.workers[workerName];
  return worker && worker.toolsets.length > 0 ? worker.toolsets : config.hermes.defaultToolsets;
}

function formatCurrentState(state: Awaited<ReturnType<typeof captureGitEvidence>>): string {
  return [
    `Git root: ${state.gitRoot ?? "unknown"}`,
    `HEAD: ${state.head ?? "unknown"}`,
    `Status: ${state.status.length > 0 ? state.status.join(" | ") : "clean"}`
  ].join("\n");
}

function emptyEvidence(): GitEvidence {
  return {
    gitRoot: null,
    head: null,
    status: [],
    changedFiles: [],
    diffStat: "",
    committedChangedFiles: [],
    committedDiffStat: ""
  };
}
