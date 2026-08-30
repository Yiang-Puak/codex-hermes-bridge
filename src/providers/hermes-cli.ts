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
  maxTurns?: number | undefined;
};

export type HermesSessionUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  apiCalls: number;
  toolCalls: number;
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
  costStatus: string;
};

export type HermesRunResult = RuntimeResult & {
  sessionId: string | null;
  usage: HermesSessionUsage | null;
  usageWarning?: string | undefined;
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

  async run(invocation: HermesInvocation): Promise<HermesRunResult> {
    const queryMode = await this.resolveQueryMode();
    const built = buildHermesInvocation(invocation, this.config.hermes.source, queryMode);
    const result = await this.runtime.run({
      args: built.args,
      ...(built.input !== undefined ? { input: built.input } : {}),
      cwd: invocation.cwd,
      timeoutMs: invocation.timeoutMs
    });
    const sessionId = parseSessionId(result.stderr);
    if (!sessionId) return { ...result, sessionId: null, usage: null };

    try {
      const exported = await this.runtime.run({
        args: ["sessions", "export", "--session-id", sessionId, "-"],
        timeoutMs: 30_000
      });
      const usage = exported.exitCode === 0 ? parseSessionUsage(exported.stdout) : null;
      return {
        ...result,
        sessionId,
        usage,
        ...(usage ? {} : { usageWarning: `Hermes usage is unavailable for session '${sessionId}'.` })
      };
    } catch {
      return {
        ...result,
        sessionId,
        usage: null,
        usageWarning: `Hermes usage is unavailable for session '${sessionId}'.`
      };
    }
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
  if (invocation.maxTurns !== undefined) args.push("--max-turns", String(invocation.maxTurns));
  args.push("--source", source, "--quiet");
  return {
    args,
    ...(queryMode === "query-file" && invocation.prompt !== undefined ? { input: invocation.prompt } : {})
  };
}

export function parseSessionId(output: string): string | null {
  return output.match(/^session_id:\s*(\S+)\s*$/mi)?.[1] ?? null;
}

export function parseSessionUsage(output: string): HermesSessionUsage | null {
  try {
    const data = JSON.parse(output.trim()) as Record<string, unknown>;
    const inputTokens = nonNegativeInteger(data.input_tokens);
    const outputTokens = nonNegativeInteger(data.output_tokens);
    if (inputTokens === null || outputTokens === null) return null;
    const cacheReadTokens = nonNegativeInteger(data.cache_read_tokens) ?? 0;
    const cacheWriteTokens = nonNegativeInteger(data.cache_write_tokens) ?? 0;
    return {
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      reasoningTokens: nonNegativeInteger(data.reasoning_tokens) ?? 0,
      totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
      apiCalls: nonNegativeInteger(data.api_call_count) ?? 0,
      toolCalls: nonNegativeInteger(data.tool_call_count) ?? 0,
      estimatedCostUsd: nonNegativeNumber(data.estimated_cost_usd),
      actualCostUsd: nonNegativeNumber(data.actual_cost_usd),
      costStatus: typeof data.cost_status === "string" ? data.cost_status : "unknown"
    };
  } catch {
    return null;
  }
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
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
