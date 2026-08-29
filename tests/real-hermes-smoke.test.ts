import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";
import { BridgeConfigSchema } from "../src/types.js";
import { HermesCliProvider } from "../src/providers/hermes-cli.js";
import { runWorker } from "../src/execution/worker-runner.js";

const enabled = Boolean(
  process.env.CHB_REAL_PROFILE && process.env.CHB_REAL_PROVIDER && process.env.CHB_REAL_MODEL
);

describe.skipIf(!enabled)("real Hermes smoke", () => {
  it(
    "executes one bounded file-edit task and returns Git evidence",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "chb-real-hermes-"));
      try {
        await writeFile(join(root, "target.txt"), "before\n", "utf8");
        for (const args of [
          ["init", "-q"],
          ["config", "user.email", "real-smoke@example.invalid"],
          ["config", "user.name", "Real Hermes Smoke"],
          ["add", "."],
          ["commit", "-qm", "fixture"]
        ]) {
          const result = await runCommand("git", ["-C", root, ...args], { timeoutMs: 10_000 });
          if (result.exitCode !== 0) throw new Error(result.stderr);
        }

        const config = BridgeConfigSchema.parse({
          hermes: {
            runtime: process.env.CHB_REAL_RUNTIME ?? "wsl",
            command: process.env.CHB_REAL_COMMAND ?? "hermes",
            distro: process.env.CHB_REAL_DISTRO,
            queryMode: "auto",
            timeoutMs: 300_000,
            defaultToolsets: ["hermes-cli"],
            source: "tool"
          },
          providers: {
            smoke: { hermesProvider: process.env.CHB_REAL_PROVIDER }
          },
          models: {
            smoke: {
              provider: "smoke",
              model: process.env.CHB_REAL_MODEL,
              enabled: true,
              costClass: "unknown"
            }
          },
          workers: {
            smoke: {
              profile: process.env.CHB_REAL_PROFILE,
              model: "smoke",
              role: "implementation",
              capabilities: ["repository-read", "code-write", "test"],
              toolsets: ["hermes-cli"],
              sideEffectPolicy: "local_files_allowed",
              timeoutMs: 300_000
            }
          },
          teams: { default: { roles: { coder: "smoke" }, maxParallel: 1 } },
          safety: { defaultSideEffectPolicy: "local_files_allowed", acceptHooks: false },
          execution: { collectGitEvidence: true, allowWorkerCommits: false }
        });

        const result = await runWorker(
          config,
          {
            worker: "smoke",
            cwd: root,
            task: {
              id: "real-hermes-file-edit",
              objective: "Change target.txt from before to after and validate the file.",
              context: "This is a disposable Git fixture used only for a live runtime smoke test.",
              requirements: ["Edit only target.txt.", "Do not create commits."],
              scope: { allowedPaths: ["target.txt"], forbiddenPaths: [] },
              acceptanceCriteria: ["target.txt contains exactly the line after."],
              validation: ["Read target.txt and verify its content."]
            }
          },
          new HermesCliProvider(config)
        );

        expect(result.status, JSON.stringify({ status: result.status, errors: result.errors })).toBe("completed");
        expect(result.evidence.changedFiles).toContain("target.txt");
        expect(await readFile(join(root, "target.txt"), "utf8")).toContain("after");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    360_000
  );
});
