import { runCommand } from "../command.js";
import type { BridgeConfig } from "../types.js";
import type { HermesRuntime, RuntimeCommand, RuntimeResult } from "./runtime.js";

export class DirectRuntime implements HermesRuntime {
  readonly kind = "direct" as const;

  constructor(private readonly settings: BridgeConfig["hermes"]) {}

  async run(command: RuntimeCommand): Promise<RuntimeResult> {
    const result = await runCommand(this.settings.command, command.args, {
      cwd: command.cwd,
      timeoutMs: command.timeoutMs,
      input: command.input
    });
    return {
      ...result,
      runtime: this.kind,
      command: this.settings.command,
      args: command.args
    };
  }
}
