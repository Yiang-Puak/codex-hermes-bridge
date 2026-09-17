import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";
import { parseConfigText } from "../src/config.js";
import { HermesCliProvider } from "../src/providers/hermes-cli.js";
import type { HermesRuntime, RuntimeCommand, RuntimeResult } from "../src/runtime/runtime.js";
import { runWorker, truncateWorkerReport } from "../src/execution/worker-runner.js";
import type { TaskContract } from "../src/execution/task-contract.js";

const task: TaskContract = {
  id: "fixture-change",
  objective: "Modify the fixture file.",
  context: "A fake Hermes runtime is used for a deterministic worker test.",
  requirements: ["Write the requested fixture content."],
  scope: { allowedPaths: ["changed.txt"], forbiddenPaths: [] },
  acceptanceCriteria: ["changed.txt contains the expected marker."],
  validation: ["Read changed.txt after the worker returns."]
};

function configText(): string {
  return `
hermes:
  runtime: direct
  command: fake-hermes
providers:
  local:
    hermesProvider: local
models:
  fixture:
    provider: local
    model: fixture/model
workers:
  coder:
    profile: executor
    model: fixture
    role: implementation
    capabilities: [code-write, test]
    toolsets: [coding]
    sideEffectPolicy: local_files_allowed
    maxTurns: 30
teams:
  default:
    roles:
      coder: coder
execution:
  defaultWorkspaceMode: shared
  collectGitEvidence: true
  allowWorkerCommits: false
`;
}

class FakeRuntime implements HermesRuntime {
  readonly kind = "direct" as const;

  constructor(
    private readonly writeOutOfScope: boolean,
    private readonly failUsageExport = false
  ) {}

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
      if (this.failUsageExport) throw new Error("usage export unavailable");
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
    const target = join(command.cwd ?? ".", "changed.txt");
    await writeFile(target, "worker changed this file\n", "utf8");
    if (this.writeOutOfScope) {
      await writeFile(join(command.cwd ?? ".", "outside.txt"), "out of scope\n", "utf8");
    }
    const query = command.args[command.args.indexOf("--query") + 1] ?? "";
    expect(query).toContain("FINAL RESPONSE CONTRACT");
    expect(query).toContain("Return at most 1200 characters");
    expect(query).toContain("Side-effect policy: local_files_allowed");
    expect(query).toContain("Worker commits allowed: no");
    expect(command.args).toContain("--max-turns");
    return {
      stdout: "files changed: changed.txt",
      stderr: "session_id: fixture-session",
      exitCode: 0,
      timedOut: false,
      runtime: "direct",
      command: "fake-hermes",
      args: command.args
    };
  }
}

async function createGitFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chb-worker-"));
  await writeFile(join(root, "changed.txt"), "before\n", "utf8");
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "worker-test@example.invalid"],
    ["config", "user.name", "Worker Test"],
    ["add", "."],
    ["commit", "-qm", "fixture"]
  ]) {
    const result = await runCommand("git", ["-C", root, ...args], { timeoutMs: 10_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
  return root;
}

describe("runWorker", () => {
  it("returns real changed files and git evidence", async () => {
    const root = await createGitFixture();
    try {
      await writeFile(join(root, "outside.txt"), "pre-existing user change\n", "utf8");
      const staged = await runCommand("git", ["-C", root, "add", "outside.txt"], { timeoutMs: 10_000 });
      expect(staged.exitCode).toBe(0);
      const config = parseConfigText(configText());
      const provider = new HermesCliProvider(config, new FakeRuntime(false));
      const result = await runWorker(config, { worker: "coder", cwd: root, task }, provider);

      expect(result.status).toBe("completed");
      expect(result.evidence.changedFiles).toEqual(["changed.txt"]);
      expect(result.evidence.outOfScopeChanges).toEqual([]);
      expect(result.evidence.diffStat).toContain("changed.txt");
      expect(result.evidence.diffStat).not.toContain("outside.txt");
      expect(result.progress.map((item) => item.stage)).toContain("evidence_after");
      expect(result.workspace.headBefore).toBe(result.workspace.headAfter);
      expect(result.runtime.sessionId).toBe("fixture-session");
      expect(result.usage?.totalTokens).toBe(15);
      expect(await readFile(join(root, "changed.txt"), "utf8")).toContain("worker changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an allowed-path violation without reverting the worker", async () => {
    const root = await createGitFixture();
    try {
      const config = parseConfigText(configText());
      const provider = new HermesCliProvider(config, new FakeRuntime(true, true));
      const result = await runWorker(config, { worker: "coder", cwd: root, task }, provider);

      expect(result.status).toBe("policy_violation");
      expect(result.usage).toBeNull();
      expect(result.warnings).toContain("Hermes usage is unavailable for session 'fixture-session'.");
      expect(result.evidence.changedFiles).toEqual(["changed.txt", "outside.txt"]);
      expect(result.evidence.outOfScopeChanges).toEqual(["outside.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets a worker select the native direct runtime over a global WSL runtime", async () => {
    const root = await createGitFixture();
    try {
      const config = parseConfigText(configText().replace(
        "runtime: direct\n  command: fake-hermes",
        "runtime: wsl\n  command: hermes\n  distro: Does-Not-Matter"
      ).replace(
        "profile: executor\n    model: fixture",
        "profile: executor\n    model: fixture\n    runtime: direct\n    command: node"
      ));
      const result = await runWorker(config, {
        worker: "coder",
        cwd: root,
        task,
        timeoutMs: 5_000
      });

      expect(result.status).toBe("failed");
      expect(result.runtime.kind).toBe("direct");
      expect(result.runtime.distro).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps only the tail of oversized worker reports", () => {
    expect(truncateWorkerReport("0123456789", 4)).toBe("[... 6 earlier characters omitted ...]\n6789");
  });

  it("rejects a junction that escapes the configured workspace root", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "chb-junction-"));
    const allowed = join(root, "allowed");
    const outside = join(root, "outside");
    const linked = join(allowed, "linked");
    await mkdir(allowed);
    await mkdir(outside);
    await symlink(outside, linked, "junction");
    try {
      const config = parseConfigText(`${configText()}\nsafety:\n  allowedWorkspaceRoots:\n    - '${allowed}'\n`);
      const result = await runWorker(config, { worker: "coder", cwd: linked, task }, new HermesCliProvider(config, new FakeRuntime(false)));
      expect(result.status).toBe("invalid_result");
      expect(result.errors[0]).toContain("outside configured allowedWorkspaceRoots");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a single-worker worktree and preserves a subdirectory cwd", async () => {
    const root = await createGitFixture();
    const subdirectory = join(root, "subdir");
    await mkdir(subdirectory);
    await writeFile(join(subdirectory, "seed.txt"), "seed\n", "utf8");
    const added = await runCommand("git", ["-C", root, "add", "."], { timeoutMs: 10_000 });
    expect(added.exitCode).toBe(0);
    const committed = await runCommand("git", ["-C", root, "commit", "-qm", "subdir"], { timeoutMs: 10_000 });
    expect(committed.exitCode).toBe(0);
    let worktree: string | null = null;
    try {
      const config = parseConfigText(configText());
      const result = await runWorker(config, {
        worker: "coder",
        cwd: subdirectory,
        workspaceMode: "worktree",
        task
      }, new HermesCliProvider(config, new FakeRuntime(false)));
      worktree = result.workspace.worktreePath ?? null;
      expect(result.status, JSON.stringify({ warnings: result.warnings, errors: result.errors, evidence: result.evidence })).toBe("completed");
      expect(result.workspace.mode).toBe("worktree");
      expect(result.workspace.cwd).toBe(join(worktree ?? "", "subdir"));
      expect(result.evidence.changedFiles).toEqual(["subdir/changed.txt"]);
    } finally {
      if (worktree) await runCommand("git", ["-C", root, "worktree", "remove", "--force", worktree], { timeoutMs: 10_000 });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks worktree preparation when the source workspace is dirty", async () => {
    const root = await createGitFixture();
    try {
      await writeFile(join(root, "dirty.txt"), "user change\n", "utf8");
      const config = parseConfigText(configText());
      const result = await runWorker(config, {
        worker: "coder",
        cwd: root,
        workspaceMode: "worktree",
        task
      }, new HermesCliProvider(config, new FakeRuntime(false)));
      expect(result.status).toBe("blocked");
      expect(result.errors[0]).toContain("dirty source workspace");
      expect(result.workspace.worktreePath).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
