import type { BridgeConfig, CommandResult } from "../types.js";
import { DirectRuntime } from "./direct.js";
import { WslRuntime } from "./wsl.js";

export type RuntimeCommand = {
  args: string[];
  cwd?: string | undefined;
  input?: string | undefined;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
};

export type RuntimeResult = CommandResult & {
  runtime: "direct" | "wsl";
  distro?: string | undefined;
  command: string;
  args: string[];
};

export interface HermesRuntime {
  readonly kind: "direct" | "wsl";
  run(command: RuntimeCommand): Promise<RuntimeResult>;
}

export function createRuntime(config: BridgeConfig): HermesRuntime {
  return config.hermes.runtime === "wsl"
    ? new WslRuntime(config.hermes)
    : new DirectRuntime(config.hermes);
}
