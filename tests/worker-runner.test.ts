import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";
import { parseConfigText } from "../src/config.js";
import { HermesCliProvider } from "../src/providers/hermes-cli.js";
import type { HermesRuntime, RuntimeCommand, RuntimeResult } from "../src/runtime/runtime.js";
import { runWorker } from "../src/execution/worker-runner.js";
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

  constructor(private readonly writeOutOfScope: boolean) {}

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
    const target = join(command.cwd ?? ".", "changed.txt");
    await writeFile(target, "worker changed this file\n", "utf8");
    if (this.writeOutOfScope) {
      await writeFile(join(command.cwd ?? ".", "outside.txt"), "out of scope\n", "utf8");
    }
    const query = command.args[command.args.indexOf("--query") + 1] ?? "";
    expect(query).toContain("FINAL RESPONSE CONTRACT");
    return {
      stdout: "files changed: changed.txt",
      stderr: "",
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
      expect(result.evidence.changedFiles).toEqual(["changed.txt", "outside.txt"]);
      expect(result.evidence.outOfScopeChanges).toEqual([]);
      expect(result.evidence.diffStat).toContain("outside.txt");
      expect(result.workspace.headBefore).toBe(result.workspace.headAfter);
      expect(await readFile(join(root, "changed.txt"), "utf8")).toContain("worker changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an allowed-path violation without reverting the worker", async () => {
    const root = await createGitFixture();
    try {
      const config = parseConfigText(configText());
      const provider = new HermesCliProvider(config, new FakeRuntime(true));
      const result = await runWorker(config, { worker: "coder", cwd: root, task }, provider);

      expect(result.status).toBe("policy_violation");
      expect(result.evidence.changedFiles).toEqual(["changed.txt", "outside.txt"]);
      expect(result.evidence.outOfScopeChanges).toEqual(["outside.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
