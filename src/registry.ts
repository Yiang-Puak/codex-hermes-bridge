import type {
  BridgeConfig,
  ModelConfig,
  ProviderConfig,
  TeamConfig,
  WorkerConfig
} from "./types.js";

export function getProvider(config: BridgeConfig, name: string): ProviderConfig | undefined {
  return config.providers[name];
}

export function getModel(config: BridgeConfig, name: string): ModelConfig | undefined {
  return config.models[name];
}

export function getWorker(config: BridgeConfig, name: string): WorkerConfig | undefined {
  return config.workers[name];
}

export function getTeam(config: BridgeConfig, name: string): TeamConfig | undefined {
  return config.teams[name];
}

export function listEnabledWorkers(config: BridgeConfig): Array<[string, WorkerConfig]> {
  return Object.entries(config.workers)
    .filter(([, worker]) => worker.enabled)
    .sort(([left], [right]) => left.localeCompare(right));
}

export function publicRegistry(config: BridgeConfig) {
  return {
    providers: Object.fromEntries(
      Object.entries(config.providers).sort(([left], [right]) => left.localeCompare(right))
    ),
    models: Object.fromEntries(
      Object.entries(config.models).sort(([left], [right]) => left.localeCompare(right))
    ),
    workers: Object.fromEntries(
      Object.entries(config.workers).sort(([left], [right]) => left.localeCompare(right))
    ),
    teams: Object.fromEntries(
      Object.entries(config.teams).sort(([left], [right]) => left.localeCompare(right))
    )
  };
}
