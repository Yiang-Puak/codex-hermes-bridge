import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";
import { captureGitEvidence, compareEvidence, matchesPath } from "../src/execution/evidence.js";

async function git(root: string, ...args: string[]): Promise<void> {
  const result = await runCommand("git", ["-C", root, ...args], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

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

  it("detects index-only changes when a file remains MM", async () => {
    const root = await createFixture();
    try {
      await writeFile(join(root, "README.md"), "first index\n", "utf8");
      await git(root, "add", "README.md");
      await writeFile(join(root, "README.md"), "working tree\n", "utf8");
      const before = await captureGitEvidence(root);
      expect(before.status).toContain("MM README.md");

      await writeFile(join(root, "README.md"), "second index\n", "utf8");
      await git(root, "add", "README.md");
      await writeFile(join(root, "README.md"), "working tree\n", "utf8");
      const after = await captureGitEvidence(root, before.head ?? undefined);
      const check = compareEvidence(before, after, ["README.md"], [], false, "local_files_allowed");

      expect(after.status).toContain("MM README.md");
      expect(check.changedFiles).toEqual(["README.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports both paths for a staged rename and flags the forbidden source", async () => {
    const root = await createFixture();
    try {
      await writeFile(join(root, "protected.txt"), "protected\n", "utf8");
      await git(root, "add", "protected.txt");
      await git(root, "commit", "-qm", "protected file");
      const before = await captureGitEvidence(root);

      const destination = "allowed name 名.txt";
      await git(root, "mv", "protected.txt", destination);
      const after = await captureGitEvidence(root, before.head ?? undefined);
      const check = compareEvidence(before, after, [destination], ["protected.txt"], false, "local_files_allowed");

      expect(after.changedFiles).toEqual([destination, "protected.txt"]);
      expect(check.changedFiles).toEqual([destination, "protected.txt"]);
      expect(check.outOfScopeChanges).toEqual(["protected.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports both paths for a committed rename, including the forbidden source", async () => {
    const root = await createFixture();
    try {
      await writeFile(join(root, "protected.txt"), "protected\n", "utf8");
      await git(root, "add", "protected.txt");
      await git(root, "commit", "-qm", "protected file");
      const before = await captureGitEvidence(root);

      const destination = "allowed name 名.txt";
      await git(root, "mv", "protected.txt", destination);
      await git(root, "commit", "-qm", "rename protected file");
      const after = await captureGitEvidence(root, before.head ?? undefined);
      const check = compareEvidence(before, after, [destination], ["protected.txt"], true, "local_files_allowed");

      expect(after.committedChangedFiles).toEqual([destination, "protected.txt"]);
      expect(check.changedFiles).toEqual([destination, "protected.txt"]);
      expect(check.outOfScopeChanges).toEqual(["protected.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves unicode and whitespace paths from NUL-delimited Git output", async () => {
    const root = await createFixture();
    try {
      const path = "quote ' and space 名.txt";
      await writeFile(join(root, path), "unicode path\n", "utf8");
      const evidence = await captureGitEvidence(root);

      expect(evidence.changedFiles).toContain(path);
      expect(evidence.status.some((line) => line.includes(path))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fingerprints symlink targets when the platform permits symlinks", async ({ skip }) => {
    const root = await createFixture();
    try {
      const link = join(root, "link.txt");
      await writeFile(join(root, "target-a.txt"), "a\n", "utf8");
      await writeFile(join(root, "target-b.txt"), "b\n", "utf8");
      try {
        await symlink("target-a.txt", link);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
        if (["EACCES", "EPERM", "UNKNOWN"].includes(String(code))) {
          skip();
          return;
        }
        throw error;
      }
      const before = await captureGitEvidence(root);
      await rm(link, { force: true });
      await symlink("target-b.txt", link);
      const after = await captureGitEvidence(root, before.head ?? undefined);
      const check = compareEvidence(before, after, ["link.txt"], [], false, "local_files_allowed");

      expect(check.changedFiles).toEqual(["link.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches recursive directories at zero depth and treats ? as literal", () => {
    expect(matchesPath("file.ts", "**/*.ts")).toBe(true);
    expect(matchesPath("src/file.ts", "src/**/file.ts")).toBe(true);
    expect(matchesPath("src/nested/file.ts", "src/**/file.ts")).toBe(true);
    expect(matchesPath("literal?.txt", "literal?.txt")).toBe(true);
    expect(matchesPath("literalX.txt", "literal?.txt")).toBe(false);
  });
});
