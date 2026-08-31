import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "../command.js";

export type GitEvidence = {
  gitRoot: string | null;
  head: string | null;
  status: string[];
  changedFiles: string[];
  fingerprints: Record<string, string>;
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
      fingerprints: {},
      diffStat: "",
      committedChangedFiles: [],
      committedDiffStat: "",
      error: rootResult.stderr.trim() || "cwd is not a Git repository"
    };
  }

  const [head, status, unstagedDiffStat, stagedDiffStat, unstaged, staged] = await Promise.all([
    gitText(gitRoot, ["rev-parse", "HEAD"]),
    gitText(gitRoot, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "--untracked-files=all"]),
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
  const fingerprints = await fingerprintFiles(gitRoot, statusLines, changedFiles);

  return {
    gitRoot,
    head: head.text.trim() || null,
    status: statusLines,
    changedFiles,
    fingerprints,
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
  const workingTreeFiles = unique([...before.changedFiles, ...after.changedFiles]).filter(
    (file) => before.fingerprints[file] !== after.fingerprints[file]
  );
  const changedFiles = unique([
    ...workingTreeFiles,
    ...after.committedChangedFiles
  ]);
  const newChangedFiles = changedFiles;
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
  if (["advice_only", "read_only"].includes(sideEffectPolicy) && changedFiles.length > 0) {
    warnings.push(`Side-effect policy ${sideEffectPolicy} was violated by workspace changes.`);
  }
  if (after.error) warnings.push(`Git evidence after execution is incomplete: ${after.error}`);
  return {
    changedFiles,
    newChangedFiles,
    diffStat: incrementalDiffStat(before, after, workingTreeFiles),
    statusBefore: before.status,
    statusAfter: after.status,
    outOfScopeChanges,
    warnings
  };
}

export function matchesPath(file: string, pattern: string): boolean {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedPattern = pattern.replaceAll("\\", "/");
  const escaped = normalizedPattern
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(normalizedFile);
}

async function fingerprintFiles(
  root: string,
  statusLines: string[],
  files: string[]
): Promise<Record<string, string>> {
  const statuses = new Map(statusLines.map((line) => [parseStatusPath(line), line.slice(0, 2)]));
  const entries = await Promise.all(files.map(async (file) => {
    const path = resolve(root, file);
    try {
      const metadata = await stat(path);
      const content = metadata.isFile() ? await readFile(path) : Buffer.from(`type:${metadata.isDirectory() ? "directory" : "other"}`);
      return [file, createHash("sha256").update(statuses.get(file) ?? "").update(content).digest("hex")] as const;
    } catch {
      return [file, createHash("sha256").update(statuses.get(file) ?? "").update("missing").digest("hex")] as const;
    }
  }));
  return Object.fromEntries(entries);
}

function incrementalDiffStat(before: GitEvidence, after: GitEvidence, workingTreeFiles: string[]): string {
  const workingTreeStat = before.changedFiles.length === 0
    ? after.diffStat
    : workingTreeFiles.map((file) => `${file} | changed during worker run`).join("\n");
  return [workingTreeStat, after.committedDiffStat].filter(Boolean).join("\n");
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
