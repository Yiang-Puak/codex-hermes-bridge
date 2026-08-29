import {
  getModel,
  getProvider,
  getTeam,
  getWorker,
  listEnabledWorkers
} from "./registry.js";
import type { BridgeConfig, CostClass, ResolvedRoute, WorkerConfig } from "./types.js";

export type RouteRequest = {
  team?: string | undefined;
  role?: string | undefined;
  worker?: string | undefined;
  capabilities?: string[] | undefined;
  preferences?: {
    costClass?: CostClass | undefined;
  } | undefined;
  modelOverride?: string | undefined;
};

export type RouteDecision = {
  selected: ResolvedRoute;
  candidates: string[];
  why: string;
};

export type ResolverErrorCode =
  | "team_not_found"
  | "role_not_found"
  | "worker_not_found"
  | "worker_disabled"
  | "no_capability_match"
  | "model_override_disabled"
  | "model_unavailable"
  | "missing_provider"
  | "paid_fallback_disabled";

export class ResolverError extends Error {
  constructor(
    public readonly code: ResolverErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ResolverError";
  }
}

export function resolveRoute(config: BridgeConfig, request: RouteRequest = {}): RouteDecision {
  const teamName = request.team ?? config.routing.defaultTeam;
  const team = getTeam(config, teamName);
  const selectedWorkerName = selectWorkerName(config, request, teamName, team);
  const worker = getWorker(config, selectedWorkerName);
  if (!worker) {
    throw new ResolverError("worker_not_found", `Worker '${selectedWorkerName}' was not found.`);
  }
  if (!worker.enabled) {
    throw new ResolverError("worker_disabled", `Worker '${selectedWorkerName}' is disabled.`);
  }

  const role = request.role ?? worker.role ?? "worker";
  const modelRef = request.modelOverride ?? worker.model;
  const route = resolveModel(config, worker, modelRef, request.modelOverride);
  const usedDefaultWorker =
    !request.worker &&
    !request.role &&
    config.routing.defaultWorker === selectedWorkerName;
  const why = request.worker
    ? `explicit worker ${selectedWorkerName}`
    : request.role
      ? `team ${teamName} role ${request.role} -> worker ${selectedWorkerName}`
      : usedDefaultWorker
        ? `default worker ${selectedWorkerName}`
        : `capability filter -> worker ${selectedWorkerName}`;

  return {
    selected: {
      team: teamName,
      role,
      worker: selectedWorkerName,
      profile: worker.profile,
      ...route,
      why: `${why} -> ${route.modelRef ? `model ${route.modelRef}` : "profile default"}`
    },
    candidates: candidateNames(config, request, teamName, team),
    why: `${why} -> ${route.modelRef ? `model ${route.modelRef}` : "profile default"}`
  };
}

function selectWorkerName(
  config: BridgeConfig,
  request: RouteRequest,
  teamName: string,
  team: ReturnType<typeof getTeam>
): string {
  if (request.worker) {
    const worker = getWorker(config, request.worker);
    if (!worker) {
      throw new ResolverError("worker_not_found", `Worker '${request.worker}' was not found.`);
    }
    return request.worker;
  }

  if (request.role) {
    if (!team) {
      throw new ResolverError("team_not_found", `Team '${teamName}' was not found.`);
    }
    const workerName = team.roles[request.role];
    if (!workerName) {
      throw new ResolverError(
        "role_not_found",
        `Role '${request.role}' was not found in team '${teamName}'.`
      );
    }
    return workerName;
  }

  if (config.routing.defaultWorker) return config.routing.defaultWorker;

  const candidates = filterCandidates(config, request, teamName, team);
  const first = candidates[0];
  if (!first) {
    throw new ResolverError(
      "no_capability_match",
      `No enabled worker matches the requested capabilities in team '${teamName}'.`
    );
  }
  return first;
}

function candidateNames(
  config: BridgeConfig,
  request: RouteRequest,
  teamName: string,
  team: ReturnType<typeof getTeam>
): string[] {
  if (request.worker) return [request.worker];
  if (request.role) {
    const workerName = team?.roles[request.role];
    return workerName ? [workerName] : [];
  }
  if (config.routing.defaultWorker) return [config.routing.defaultWorker];
  return filterCandidates(config, request, teamName, team);
}

function filterCandidates(
  config: BridgeConfig,
  request: RouteRequest,
  teamName: string,
  team: ReturnType<typeof getTeam>
): string[] {
  const workerNames = team
    ? Object.values(team.roles).sort((left, right) => left.localeCompare(right))
    : listEnabledWorkers(config).map(([name]) => name);
  const uniqueNames = [...new Set(workerNames)];
  const required = new Set(request.capabilities ?? []);
  return uniqueNames.filter((name) => {
    const worker = getWorker(config, name);
    if (!worker?.enabled) return false;
    if ([...required].some((capability) => !worker.capabilities.includes(capability))) return false;
    if (request.preferences?.costClass && !matchesCostClass(config, worker, request.preferences.costClass)) {
      return false;
    }
    return true;
  });
}

function matchesCostClass(config: BridgeConfig, worker: WorkerConfig, costClass: CostClass): boolean {
  if (!worker.model) return costClass === "unknown";
  return getModel(config, worker.model)?.costClass === costClass;
}

function resolveModel(
  config: BridgeConfig,
  worker: WorkerConfig,
  modelRef: string | undefined,
  explicitOverride: string | undefined
): Pick<ResolvedRoute, "modelRef" | "provider" | "model" | "modelSource"> {
  if (explicitOverride && !config.routing.allowModelOverride) {
    throw new ResolverError("model_override_disabled", "Per-call model override is disabled.");
  }
  if (!modelRef) {
    return {
      modelRef: null,
      provider: null,
      model: null,
      modelSource: "profile_default"
    };
  }

  const model = getModel(config, modelRef);
  if (!model || !model.enabled) {
    throw new ResolverError("model_unavailable", `Model '${modelRef}' is missing or disabled.`);
  }
  const provider = getProvider(config, model.provider);
  if (!provider) {
    throw new ResolverError(
      "missing_provider",
      `Provider '${model.provider}' for model '${modelRef}' is missing.`
    );
  }

  return {
    modelRef,
    provider: provider.hermesProvider,
    model: model.model,
    modelSource: explicitOverride ? "explicit_override" : "worker_registry"
  };
}
