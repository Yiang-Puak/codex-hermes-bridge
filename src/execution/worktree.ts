import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand } from "../command.js";

export type WorktreeInfo = {
  path: string;
  branch: string;
  gitRoot: string;
};

const worktreeLocks = new Map<string, Promise<void>>();

export async function createWorktree(
  gitRoot: string,
  runId: string,
  taskId: string
): Promise<WorktreeInfo> {
  const repoKey = process.platform === "win32" ? resolve(gitRoot).toLowerCase() : resolve(gitRoot);
  const previous = worktreeLocks.get(repoKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const queued = previous.then(() => current);
  worktreeLocks.set(repoKey, queued);
  await previous;
  try {
    const safeRun = sanitizePart(runId);
    const safeTask = sanitizePart(taskId);
    const repoId = createHash("sha256").update(resolve(gitRoot)).digest("hex").slice(0, 12);
    const worktreeRoot = join(tmpdir(), "codex-hermes-bridge", repoId);
    const path = join(worktreeRoot, `chb-${safeRun}-${safeTask}`);
    const branch = `chb/${safeRun}/${safeTask}`;
    mkdirSync(worktreeRoot, { recursive: true });
    const result = await runCommand("git", ["-C", gitRoot, "worktree", "add", "-b", branch, path, "HEAD"], {
      timeoutMs: 30_000
    });
    if (result.exitCode !== 0) {
      throw new Error(`Could not create worktree '${path}': ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return { path, branch, gitRoot };
  } finally {
    release();
    if (worktreeLocks.get(repoKey) === queued) worktreeLocks.delete(repoKey);
  }
}

export function isWritePolicy(policy: string): boolean {
  return !["advice_only", "read_only"].includes(policy);
}

function sanitizePart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-");
  return safe || "task";
}
