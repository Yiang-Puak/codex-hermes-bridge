import { runCommand } from "../command.js";
import type { BridgeConfig } from "../types.js";
import { resolveWindowsPathToWsl } from "./paths.js";
import type { HermesRuntime, RuntimeCommand, RuntimeResult } from "./runtime.js";

export class WslRuntime implements HermesRuntime {
  readonly kind = "wsl" as const;

  constructor(private readonly settings: BridgeConfig["hermes"]) {}

  async run(command: RuntimeCommand): Promise<RuntimeResult> {
    const args = buildWslArgs(this.settings, command);
    const result = await runCommand("wsl.exe", args, {
      timeoutMs: command.timeoutMs,
      input: command.input
    });
    return {
      ...result,
      runtime: this.kind,
      distro: this.settings.distro,
      command: "wsl.exe",
      args
    };
  }
}

export function buildWslArgs(
  settings: BridgeConfig["hermes"],
  command: RuntimeCommand
): string[] {
  if (!settings.distro) {
    throw new Error("WSL runtime requires hermes.distro in the bridge config.");
  }

  const args = ["-d", settings.distro];
  if (command.cwd) {
    args.push("--cd", resolveWindowsPathToWsl(command.cwd));
  }
  // `wsl.exe` does not start a login shell, so user-local Hermes installs are
  // commonly absent from PATH. `env` preserves argv safety while adding the
  // conventional user-local bin directory; command/profile/model values stay
  // configuration-driven.
  args.push(
    "--",
    "/usr/bin/env",
    "PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    settings.command,
    ...command.args
  );
  return args;
}
