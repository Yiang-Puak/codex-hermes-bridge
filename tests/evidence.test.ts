import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";
import { captureGitEvidence, compareEvidence } from "../src/execution/evidence.js";

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chb-evidence-"));
  await writeFile(join(root, "README.md"), "fixture\n", "utf8");
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "evidence-test@example.invalid"],
    ["config", "user.name", "Evidence Test"],
    ["add", "."],
    ["commit", "-qm", "fixture"]
  ]) {
    const result = await runCommand("git", ["-C", root, ...args], { timeoutMs: 10_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
  return root;
}

describe("Git evidence", () => {
  it("reports files changed by a worker commit as well as working-tree changes", async () => {
    const root = await createFixture();
    try {
      const before = await captureGitEvidence(root);
      await writeFile(join(root, "allowed.txt"), "allowed\n", "utf8");
      await writeFile(join(root, "outside.txt"), "outside\n", "utf8");
      const staged = await runCommand("git", ["-C", root, "add", "allowed.txt", "outside.txt"], { timeoutMs: 10_000 });
      expect(staged.exitCode).toBe(0);
      const committed = await runCommand("git", ["-C", root, "commit", "-qm", "worker changes"], { timeoutMs: 10_000 });
      expect(committed.exitCode).toBe(0);

      const after = await captureGitEvidence(root, before.head ?? undefined);
      const check = compareEvidence(before, after, ["allowed.txt"], [], true, "local_files_allowed");

      expect(after.committedChangedFiles).toEqual(["allowed.txt", "outside.txt"]);
      expect(check.changedFiles).toEqual(["allowed.txt", "outside.txt"]);
      expect(check.outOfScopeChanges).toEqual(["outside.txt"]);
      expect(check.diffStat).toContain("outside.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("distinguishes untouched dirty files from dirty files changed again by the worker", async () => {
    const root = await createFixture();
    try {
      await writeFile(join(root, "README.md"), "user baseline\n", "utf8");
      await writeFile(join(root, "untouched.txt"), "existing dirty file\n", "utf8");
      const before = await captureGitEvidence(root);

      await writeFile(join(root, "README.md"), "worker changed the dirty file\n", "utf8");
      const after = await captureGitEvidence(root, before.head ?? undefined);
      const check = compareEvidence(before, after, ["README.md"], [], false, "local_files_allowed");

      expect(check.changedFiles).toEqual(["README.md"]);
      expect(check.diffStat).toContain("README.md | changed during worker run");
      expect(check.diffStat).not.toContain("untouched.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
