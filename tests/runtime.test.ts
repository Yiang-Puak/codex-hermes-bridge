import { execPath } from "node:process";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";
import { parseConfigText } from "../src/config.js";
import { buildHermesArgs, buildHermesInvocation } from "../src/providers/hermes-cli.js";
import { resolveWindowsPathToWsl } from "../src/runtime/paths.js";
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
        timeoutMs: 1000
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
      "PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
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
});
