import { resolve } from "node:path";
import { runCommand } from "../command.js";

export type GitEvidence = {
  gitRoot: string | null;
  head: string | null;
  status: string[];
  changedFiles: string[];
  diffStat: string;
  committedChangedFiles: string[];
  committedDiffStat: string;
  error?: string | undefined;
};

export type EvidenceCheck = {
  changedFiles: string[];
  newChangedFiles: string[];
  diffStat: string;
  statusBefore: string[];
  statusAfter: string[];
  outOfScopeChanges: string[];
  warnings: string[];
};

export async function captureGitEvidence(cwd: string, sinceHead?: string): Promise<GitEvidence> {
  const rootResult = await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    timeoutMs: 10_000
  }).catch((error: unknown) => ({
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    exitCode: null,
    timedOut: false
  }));
  const gitRoot = rootResult.exitCode === 0 ? rootResult.stdout.trim() : null;
  if (!gitRoot) {
    return {
      gitRoot: null,
      head: null,
      status: [],
      changedFiles: [],
      diffStat: "",
      committedChangedFiles: [],
      committedDiffStat: "",
      error: rootResult.stderr.trim() || "cwd is not a Git repository"
    };
  }

  const [head, status, unstagedDiffStat, stagedDiffStat, unstaged, staged] = await Promise.all([
    gitText(gitRoot, ["rev-parse", "HEAD"]),
    gitText(gitRoot, ["status", "--porcelain=v1"]),
    gitText(gitRoot, ["diff", "--stat"]),
    gitText(gitRoot, ["diff", "--cached", "--stat"]),
    gitText(gitRoot, ["diff", "--name-only"]),
    gitText(gitRoot, ["diff", "--cached", "--name-only"])
  ]);
  const statusLines = nonEmptyLines(status.text);
  const currentHead = head.text.trim();
  let committed: Array<{ text: string; error?: string }> = [{ text: "" }, { text: "" }];
  if (sinceHead && currentHead && sinceHead !== currentHead) {
    committed = await Promise.all([
      gitText(gitRoot, ["diff", "--name-only", sinceHead, currentHead]),
      gitText(gitRoot, ["diff", "--stat", sinceHead, currentHead])
    ]);
  }
  const committedFiles = committed[0] ?? { text: "" };
  const committedStat = committed[1] ?? { text: "" };
  const changedFiles = unique([
    ...nonEmptyLines(unstaged.text),
    ...nonEmptyLines(staged.text),
    ...statusLines.map(parseStatusPath).filter((path): path is string => path !== null)
  ]);

  return {
    gitRoot,
    head: head.text.trim() || null,
    status: statusLines,
    changedFiles,
    diffStat: [unstagedDiffStat.text.trim(), stagedDiffStat.text.trim()].filter(Boolean).join("\n"),
    committedChangedFiles: unique(nonEmptyLines(committedFiles.text)),
    committedDiffStat: committedStat.text.trim(),
    ...(head.error || status.error || unstagedDiffStat.error || stagedDiffStat.error || unstaged.error || staged.error || committedFiles.error || committedStat.error
      ? { error: [head.error, status.error, unstagedDiffStat.error, stagedDiffStat.error, unstaged.error, staged.error, committedFiles.error, committedStat.error].filter(Boolean).join("; ") }
      : {})
  };
}

export function compareEvidence(
  before: GitEvidence,
  after: GitEvidence,
  allowedPaths: string[],
  forbiddenPaths: string[],
  allowWorkerCommits: boolean,
  sideEffectPolicy: string
): EvidenceCheck {
  const changedFiles = unique([...after.changedFiles, ...after.committedChangedFiles]);
  const beforeSet = new Set(before.changedFiles);
  const newChangedFiles = unique([
    ...after.changedFiles.filter((file) => !beforeSet.has(file)),
    ...after.committedChangedFiles
  ]);
  const outOfScopeChanges = newChangedFiles.filter(
    (file) =>
      (allowedPaths.length > 0 && !allowedPaths.some((pattern) => matchesPath(file, pattern))) ||
      forbiddenPaths.some((pattern) => matchesPath(file, pattern))
  );
  const warnings: string[] = [];
  if (before.head && after.head && before.head !== after.head && !allowWorkerCommits) {
    warnings.push("Worker changed HEAD while execution.allowWorkerCommits is false.");
  }
  if (outOfScopeChanges.length > 0) {
    warnings.push(`Worker changed paths outside the declared scope: ${outOfScopeChanges.join(", ")}`);
  }
  if (["advice_only", "read_only"].includes(sideEffectPolicy) && !sameSet(before.status, after.status)) {
    warnings.push(`Side-effect policy ${sideEffectPolicy} was violated by workspace changes.`);
  }
  if (after.error) warnings.push(`Git evidence after execution is incomplete: ${after.error}`);
  return {
    changedFiles,
    newChangedFiles,
    diffStat: [after.diffStat, after.committedDiffStat].filter(Boolean).join("\n"),
    statusBefore: before.status,
    statusAfter: after.status,
    outOfScopeChanges,
    warnings
  };
}

function matchesPath(file: string, pattern: string): boolean {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedPattern = pattern.replaceAll("\\", "/");
  const escaped = normalizedPattern
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(normalizedFile);
}

async function gitText(root: string, args: string[]): Promise<{ text: string; error?: string }> {
  const result = await runCommand("git", ["-C", root, ...args], { timeoutMs: 10_000 }).catch((error: unknown) => ({
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    exitCode: null,
    timedOut: false
  }));
  if (result.exitCode !== 0) {
    return { text: result.stdout, error: result.stderr.trim() || `git ${args.join(" ")} failed` };
  }
  return { text: result.stdout };
}

function parseStatusPath(line: string): string | null {
  const value = line.slice(2).trim();
  if (!value) return null;
  const rename = value.split(" -> ");
  return (rename[rename.length - 1] ?? value).replaceAll('"', "");
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function unique(items: string[]): string[] {
  return [...new Set(items)].sort((left, right) => left.localeCompare(right));
}

function sameSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = new Set(left);
  return right.every((item) => a.has(item));
}
