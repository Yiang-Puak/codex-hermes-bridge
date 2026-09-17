import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";
import { BridgeConfigSchema } from "../src/types.js";
import { HermesCliProvider } from "../src/providers/hermes-cli.js";
import type { HermesRuntime, RuntimeCommand, RuntimeResult } from "../src/runtime/runtime.js";
import { runTeam } from "../src/execution/team-runner.js";

class ParallelFakeRuntime implements HermesRuntime {
  readonly kind = "direct" as const;
  active = 0;
  maximum = 0;

  async run(command: RuntimeCommand): Promise<RuntimeResult> {
    if (command.args.includes("--help")) {
      return {
        stdout: "usage: hermes chat --query QUERY",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        runtime: "direct",
        command: "fake-hermes",
        args: command.args
      };
    }
    if (command.args.includes("sessions") && command.args.includes("export")) {
      return {
        stdout: JSON.stringify({ input_tokens: 10, output_tokens: 5, api_call_count: 2, tool_call_count: 1 }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        runtime: "direct",
        command: "fake-hermes",
        args: command.args
      };
    }
    this.active += 1;
    this.maximum = Math.max(this.maximum, this.active);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const profile = command.args[command.args.indexOf("-p") + 1] ?? "unknown";
    if (profile !== "fail") {
      await writeFile(join(command.cwd ?? ".", "result.txt"), `${profile}\n`, "utf8");
    }
    this.active -= 1;
    return {
      stdout: profile === "fail" ? "" : `completed ${profile}`,
      stderr: `${profile === "fail" ? "fake failure\n" : ""}session_id: ${profile}`,
      exitCode: profile === "fail" ? 1 : 0,
      timedOut: false,
      runtime: "direct",
      command: "fake-hermes",
      args: command.args
    };
  }
}

class FailFastRuntime implements HermesRuntime {
  readonly kind = "direct" as const;
  readonly runs: string[] = [];

  async run(command: RuntimeCommand): Promise<RuntimeResult> {
    if (command.args.includes("--help")) {
      return { stdout: "usage: hermes chat --query QUERY", stderr: "", exitCode: 0, timedOut: false, runtime: "direct", command: "fake-hermes", args: command.args };
    }
    if (command.args.includes("sessions") && command.args.includes("export")) {
      return { stdout: JSON.stringify({ input_tokens: 1, output_tokens: 1 }), stderr: "", exitCode: 0, timedOut: false, runtime: "direct", command: "fake-hermes", args: command.args };
    }
    const profile = command.args[command.args.indexOf("-p") + 1] ?? "unknown";
    this.runs.push(profile);
    if (profile === "fail") {
      return { stdout: "", stderr: "failed", exitCode: 1, timedOut: false, runtime: "direct", command: "fake-hermes", args: command.args };
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { stdout: `completed ${profile}`, stderr: "", exitCode: 0, timedOut: false, runtime: "direct", command: "fake-hermes", args: command.args };
  }
}

const task = (id: string) => ({
  id,
  objective: "Write the result marker.",
  context: "Independent fake worker task.",
  requirements: ["Write result.txt in the assigned workspace."],
  scope: { allowedPaths: ["result.txt"], forbiddenPaths: [] },
  acceptanceCriteria: ["The result marker exists."],
  validation: ["Read result.txt."]
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chb-team-"));
  await writeFile(join(root, "README.md"), "fixture\n", "utf8");
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "team-test@example.invalid"],
    ["config", "user.name", "Team Test"],
    ["add", "."],
    ["commit", "-qm", "fixture"]
  ]) {
    const result = await runCommand("git", ["-C", root, ...args], { timeoutMs: 10_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
  return root;
}

function config() {
  return BridgeConfigSchema.parse({
    hermes: { runtime: "direct", command: "fake-hermes", queryMode: "auto" },
    providers: { local: { hermesProvider: "local" } },
    models: { fixture: { provider: "local", model: "fixture/model" } },
    workers: {
      alpha: { profile: "alpha", model: "fixture", role: "implementation", sideEffectPolicy: "local_files_allowed" },
      fail: { profile: "fail", model: "fixture", role: "implementation", sideEffectPolicy: "local_files_allowed" },
      beta: { profile: "beta", model: "fixture", role: "implementation", sideEffectPolicy: "local_files_allowed" }
    },
    teams: { default: { roles: { alpha: "alpha", fail: "fail", beta: "beta" }, maxParallel: 2 } },
    execution: { maxParallel: 2, parallelWriteWorkspaceMode: "worktree", collectGitEvidence: true }
  });
}

describe("runTeam", () => {
  it("bounds parallel writes, isolates worktrees, and keeps failed results", async () => {
    const root = await createFixture();
    const runtime = new ParallelFakeRuntime();
    const bridgeConfig = config();
    const provider = new HermesCliProvider(bridgeConfig, runtime);
    const requests = ["alpha", "fail", "beta"].map((worker) => ({
      id: worker,
      worker,
      cwd: root,
      task: task(worker)
    }));
    const worktrees: string[] = [];
    try {
      const result = await runTeam(bridgeConfig, { team: "default", mode: "parallel", tasks: requests }, provider);
      worktrees.push(...result.results.map((item) => item.workspace.worktreePath).filter((value): value is string => Boolean(value)));

      expect(result.status).toBe("partial");
      expect(result.maxParallel).toBe(2);
      expect(result.results.map((item) => item.status)).toEqual(["completed", "failed", "completed"]);
      expect(result.usage).toMatchObject({ measuredWorkers: 3, totalWorkers: 3, totalTokens: 45, apiCalls: 6 });
      expect(runtime.maximum).toBeLessThanOrEqual(2);
      expect(new Set(worktrees).size).toBe(3);
      expect(worktrees.every((worktree) => relative(root, worktree).startsWith(".."))).toBe(true);
      expect(result.results.every((item) => item.workspace.mode === "worktree")).toBe(true);
      expect(result.results.every((item) => item.evidence.changedFiles.includes("result.txt") || item.status === "failed")).toBe(true);

      const status = await runCommand("git", ["-C", root, "status", "--porcelain=v1"], { timeoutMs: 10_000 });
      expect(status.stdout.trim()).toBe("");
    } finally {
      for (const worktree of worktrees) {
        await runCommand("git", ["-C", root, "worktree", "remove", "--force", worktree], { timeoutMs: 10_000 });
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate task IDs before starting workers", async () => {
    const root = await createFixture();
    try {
      const bridgeConfig = config();
      const result = await runTeam(bridgeConfig, {
        team: "default",
        mode: "parallel",
        tasks: [
          { id: "same", worker: "alpha", cwd: root, task: task("same") },
          { id: "same", worker: "beta", cwd: root, task: task("same") }
        ]
      }, new HermesCliProvider(bridgeConfig, new ParallelFakeRuntime()));

      expect(result.status).toBe("failed");
      expect(result.results).toEqual([]);
      expect(result.errors[0]).toContain("Duplicate task IDs");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing top-level task ID before starting workers", async () => {
    const root = await createFixture();
    try {
      const bridgeConfig = config();
      const result = await runTeam(bridgeConfig, {
        team: "default",
        mode: "parallel",
        tasks: [{ worker: "alpha", cwd: root, task: task("nested-only") } as never]
      }, new HermesCliProvider(bridgeConfig, new ParallelFakeRuntime()));

      expect(result.status).toBe("failed");
      expect(result.results).toEqual([]);
      expect(result.errors).toEqual(["Task at index 0 is missing a non-empty top-level id."]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops queued tasks after the first failure when failFast is enabled", async () => {
    const root = await createFixture();
    const runtime = new FailFastRuntime();
    const bridgeConfig = BridgeConfigSchema.parse({
      ...config(),
      execution: { ...config().execution, maxParallel: 1, failFast: true }
    });
    const worktrees: string[] = [];
    try {
      const result = await runTeam(bridgeConfig, {
        team: "default",
        mode: "parallel",
        tasks: ["fail", "alpha", "beta"].map((worker) => ({ id: worker, worker, cwd: root, task: task(worker) }))
      }, new HermesCliProvider(bridgeConfig, runtime));
      worktrees.push(...result.results.map((item) => item.workspace.worktreePath).filter((value): value is string => Boolean(value)));
      expect(runtime.runs).toEqual(["fail"]);
      expect(result.results.map((item) => item.status)).toEqual(["failed", "blocked", "blocked"]);
      expect(result.results[1]?.errors[0]).toContain("failFast");
    } finally {
      for (const worktree of worktrees) await runCommand("git", ["-C", root, "worktree", "remove", "--force", worktree], { timeoutMs: 10_000 });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects dependent tasks before starting any worker", async () => {
    const root = await createFixture();
    const runtime = new FailFastRuntime();
    try {
      const bridgeConfig = config();
      const result = await runTeam(bridgeConfig, {
        team: "default",
        mode: "parallel",
        tasks: [{ id: "dependent", worker: "alpha", cwd: root, task: { ...task("dependent"), dependsOn: ["first"] } }]
      }, new HermesCliProvider(bridgeConfig, runtime));
      expect(result.status).toBe("failed");
      expect(result.results).toEqual([]);
      expect(runtime.runs).toEqual([]);
      expect(result.errors[0]).toContain("dependsOn");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
