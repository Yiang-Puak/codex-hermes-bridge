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
      input: command.input,
      signal: command.signal
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
  // Preserve the distro's PATH and prepend its user-local bin without using a
  // shell. The configured command and task arguments remain separate argv items.
  args.push(
    "--",
    "/usr/bin/env",
    "-S",
    'PATH="${HOME}/.local/bin:${PATH}"',
    settings.command,
    ...command.args
  );
  return args;
}
