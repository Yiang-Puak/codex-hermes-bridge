import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../command.js";

export type WorktreeInfo = {
  path: string;
  branch: string;
  gitRoot: string;
};

export async function createWorktree(
  gitRoot: string,
  runId: string,
  taskId: string
): Promise<WorktreeInfo> {
  const safeRun = sanitizePart(runId);
  const safeTask = sanitizePart(taskId);
  const worktreeRoot = join(gitRoot, ".worktrees");
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
}

export function isWritePolicy(policy: string): boolean {
  return !["advice_only", "read_only"].includes(policy);
}

function sanitizePart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-");
  return safe || "task";
}
