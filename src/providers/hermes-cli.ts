import type { BridgeConfig, QueryMode } from "../types.js";
import { createRuntime, type HermesRuntime, type RuntimeResult } from "../runtime/runtime.js";

export type HermesInvocation = {
  profile: string;
  provider?: string | undefined;
  model?: string | undefined;
  toolsets: string[];
  cwd?: string | undefined;
  prompt?: string | undefined;
  timeoutMs: number;
};

type ProfileListRow = {
  profile: string;
  model?: string | undefined;
  gateway?: string | undefined;
};

export class HermesCliProvider {
  private readonly runtime: HermesRuntime;

  constructor(
    private readonly config: BridgeConfig,
    runtime?: HermesRuntime
  ) {
    this.runtime = runtime ?? createRuntime(config);
  }

  async health(): Promise<{
    ok: boolean;
    version: string | null;
    stderr?: string;
    runtime: HermesRuntime["kind"];
    distro?: string;
  }> {
    const result = await this.runtime.run({
      args: ["--version"],
      timeoutMs: 15_000
    });
    return {
      ok: result.exitCode === 0,
      version: result.stdout.trim() || result.stderr.trim() || null,
      ...(result.stderr.trim() ? { stderr: result.stderr.trim() } : {}),
      runtime: result.runtime,
      ...(result.distro ? { distro: result.distro } : {})
    };
  }

  async discoverProfiles(): Promise<ProfileListRow[]> {
    const result = await this.runtime.run({
      args: ["profile", "list"],
      timeoutMs: 30_000
    });
    if (result.exitCode !== 0) return [];
    return parseProfileList(result.stdout);
  }

  async run(invocation: HermesInvocation): Promise<RuntimeResult> {
    const queryMode = await this.resolveQueryMode();
    const built = buildHermesInvocation(invocation, this.config.hermes.source, queryMode);
    return this.runtime.run({
      args: built.args,
      ...(built.input !== undefined ? { input: built.input } : {}),
      cwd: invocation.cwd,
      timeoutMs: invocation.timeoutMs
    });
  }

  getRuntime(): HermesRuntime {
    return this.runtime;
  }

  private queryMode: QueryMode | null = null;

  private async resolveQueryMode(): Promise<QueryMode> {
    if (this.queryMode) return this.queryMode;
    if (this.config.hermes.queryMode !== "auto") {
      this.queryMode = this.config.hermes.queryMode;
      return this.queryMode;
    }
    const help = await this.runtime.run({ args: ["chat", "--help"], timeoutMs: 10_000 });
    this.queryMode = `${help.stdout}\n${help.stderr}`.includes("--query-file") ? "query-file" : "query";
    return this.queryMode;
  }
}

export type BuiltHermesInvocation = {
  args: string[];
  input?: string | undefined;
};

export function buildHermesArgs(
  invocation: HermesInvocation,
  source: string,
  queryMode: QueryMode = "query"
): string[] {
  return buildHermesInvocation(invocation, source, queryMode).args;
}

export function buildHermesInvocation(
  invocation: HermesInvocation,
  source: string,
  queryMode: QueryMode
): BuiltHermesInvocation {
  const args = ["-p", invocation.profile, "chat"];

  if (queryMode === "query-file") {
    args.push("--query-file", "-");
  } else if (invocation.prompt !== undefined) {
    args.push("--query", invocation.prompt);
  }
  if (invocation.provider) args.push("--provider", invocation.provider);
  if (invocation.model) args.push("--model", invocation.model);
  if (invocation.toolsets.length > 0) args.push("--toolsets", invocation.toolsets.join(","));
  args.push("--source", source, "--quiet");
  return {
    args,
    ...(queryMode === "query-file" && invocation.prompt !== undefined ? { input: invocation.prompt } : {})
  };
}

export function parseProfileList(output: string): ProfileListRow[] {
  const rows: ProfileListRow[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/[◆│┃┆]/g, " ").trim();
    if (!line || line.startsWith("Profile") || line.startsWith("─")) continue;

    const parts = line.split(/\s{2,}|\t+/).map((item) => item.trim()).filter(Boolean);
    const [profile, model, gateway] = parts;
    if (!profile || profile === "Profile" || profile.includes("─")) continue;
    rows.push({ profile, model, gateway });
  }
  return rows;
}
