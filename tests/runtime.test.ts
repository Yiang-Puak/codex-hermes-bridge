import { execPath } from "node:process";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";
import { parseConfigText } from "../src/config.js";
import {
  buildHermesArgs,
  buildHermesInvocation,
  HermesCliProvider,
  parseSessionId,
  parseSessionUsage
} from "../src/providers/hermes-cli.js";
import { resolveWindowsPathToWsl } from "../src/runtime/paths.js";
import type { HermesRuntime, RuntimeCommand, RuntimeResult } from "../src/runtime/runtime.js";
import { buildWslArgs } from "../src/runtime/wsl.js";

describe("runtime adapters", () => {
  it("preserves special prompt characters in one argv element", () => {
    const prompt = `quote 'double " backtick \` command $(echo unsafe) 中文\nnext`;
    const args = buildHermesArgs(
      {
        profile: "executor",
        provider: "openrouter",
        model: "example/model",
        toolsets: ["coding", "tests"],
        prompt,
        timeoutMs: 1000,
        maxTurns: 30
      },
      "tool"
    );

    expect(args).toEqual([
      "-p",
      "executor",
      "chat",
      "--query",
      prompt,
      "--provider",
      "openrouter",
      "--model",
      "example/model",
      "--toolsets",
      "coding,tests",
      "--max-turns",
      "30",
      "--source",
      "tool",
      "--quiet"
    ]);
  });

  it("converts Windows paths and keeps WSL distro configurable", () => {
    const config = parseConfigText(`
hermes:
  runtime: wsl
  command: hermes
  distro: Test Distro
`);
    const args = buildWslArgs(config.hermes, {
      args: ["--version"],
      cwd: "C:\\repo with spaces",
      timeoutMs: 1000
    });

    expect(resolveWindowsPathToWsl("C:\\repo with spaces")).toBe("/mnt/c/repo with spaces");
    expect(args).toEqual([
      "-d",
      "Test Distro",
      "--cd",
      "/mnt/c/repo with spaces",
      "--",
      "/usr/bin/env",
      "-S",
      'PATH="${HOME}/.local/bin:${PATH}"',
      "hermes",
      "--version"
    ]);
  });

  it("uses stdin query-file mode when the installed Hermes supports it", () => {
    const prompt = "line one\nquotes: ' \" $(safe)";
    expect(buildHermesInvocation({
      profile: "executor",
      toolsets: [],
      prompt,
      timeoutMs: 1000
    }, "tool", "query-file")).toEqual({
      args: ["-p", "executor", "chat", "--query-file", "-", "--source", "tool", "--quiet"],
      input: prompt
    });
  });

  it("parses quiet-mode session metadata and normalized usage", () => {
    expect(parseSessionId("diagnostic\n\nsession_id: 20260830_143310_502bf7\n")).toBe("20260830_143310_502bf7");
    expect(parseSessionUsage(JSON.stringify({
      input_tokens: 10,
      cache_read_tokens: 20,
      cache_write_tokens: 3,
      output_tokens: 4,
      reasoning_tokens: 2,
      api_call_count: 5,
      tool_call_count: 6,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: "unknown"
    }))).toEqual({
      inputTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 3,
      outputTokens: 4,
      reasoningTokens: 2,
      totalTokens: 37,
      apiCalls: 5,
      toolCalls: 6,
      estimatedCostUsd: 0,
      actualCostUsd: null,
      costStatus: "unknown"
    });
  });

  it("reports stdin, stderr, exit code, and timeout without a shell", async () => {
    const result = await runCommand(
      execPath,
      ["-e", "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d)); process.stderr.write('diagnostic')"],
      { input: "中文 $(not-a-command)", timeoutMs: 5000 }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("中文 $(not-a-command)");
    expect(result.stderr).toBe("diagnostic");
    expect(result.timedOut).toBe(false);
  });

  it("marks a process that exceeds the timeout", async () => {
    const result = await runCommand(execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeoutMs: 20 });

    expect(result.timedOut).toBe(true);
  });

  it("rejects when a child closes stdin before a large prompt is delivered", async () => {
    await expect(runCommand(
      execPath,
      ["-e", "process.stdin.destroy(); setTimeout(() => process.exit(0), 25)"],
      { input: "x".repeat(1024 * 1024), timeoutMs: 5000 }
    )).rejects.toBeInstanceOf(Error);
  });

  it.each([
    ["stdout", "process.stdout.write('x'.repeat(128))"],
    ["stderr", "process.stderr.write('x'.repeat(128))"]
  ] as const)("rejects when %s exceeds the output limit", async (stream, script) => {
    await expect(runCommand(execPath, ["-e", script], {
      maxOutputBytes: 32,
      timeoutMs: 5000
    })).rejects.toMatchObject({ name: "CommandOutputLimitError", stream, limitBytes: 32 });
  });

  it("rejects with AbortError when cancelled", async () => {
    const controller = new AbortController();
    const result = runCommand(execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      signal: controller.signal,
      timeoutMs: 5000
    });
    setTimeout(() => controller.abort(), 20);

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});

function runtimeResult(command: RuntimeCommand, overrides: Partial<RuntimeResult> = {}): RuntimeResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    runtime: "direct",
    command: "fake-hermes",
    args: command.args,
    ...overrides
  };
}

class SessionExportRuntime implements HermesRuntime {
  readonly kind = "direct" as const;
  readonly calls: RuntimeCommand[] = [];

  async run(command: RuntimeCommand): Promise<RuntimeResult> {
    this.calls.push(command);
    const profile = command.args[command.args.indexOf("-p") + 1] ?? "unknown";
    if (command.args.includes("sessions")) {
      return runtimeResult(command, {
        stdout: JSON.stringify({ input_tokens: 2, output_tokens: 3, api_call_count: 1, tool_call_count: 1 })
      });
    }
    return runtimeResult(command, {
      stdout: `completed ${profile}`,
      stderr: `session_id: ${profile}-session`
    });
  }
}

class HelpFailureRuntime implements HermesRuntime {
  readonly kind = "direct" as const;
  readonly calls: RuntimeCommand[] = [];

  async run(command: RuntimeCommand): Promise<RuntimeResult> {
    this.calls.push(command);
    return runtimeResult(command, { stderr: "probe failed", exitCode: 2 });
  }
}

describe("Hermes CLI provider runtime boundaries", () => {
  it("exports each session with the invocation profile", async () => {
    const config = parseConfigText("hermes:\n  runtime: direct\n  command: fake-hermes\n  queryMode: query\n");
    const runtime = new SessionExportRuntime();
    const provider = new HermesCliProvider(config, runtime);

    for (const profile of ["alpha", "beta"]) {
      const result = await provider.run({
        profile,
        toolsets: [],
        prompt: `prompt for ${profile}`,
        timeoutMs: 5000
      });
      expect(result.usage?.totalTokens).toBe(5);
    }

    expect(runtime.calls.filter((call) => call.args.includes("sessions")).map((call) => call.args.slice(0, 2))).toEqual([
      ["-p", "alpha"],
      ["-p", "beta"]
    ]);
  });

  it("fails explicitly when the help probe exits nonzero", async () => {
    const config = parseConfigText("hermes:\n  runtime: direct\n  command: fake-hermes\n");
    const runtime = new HelpFailureRuntime();
    const provider = new HermesCliProvider(config, runtime);

    await expect(provider.run({
      profile: "executor",
      toolsets: [],
      prompt: "secret prompt should not appear in this error",
      timeoutMs: 5000
    })).rejects.toThrow("Hermes chat --help probe failed (exit code 2).");
    expect(runtime.calls).toHaveLength(1);
  });
});
