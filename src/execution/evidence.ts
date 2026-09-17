import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "../command.js";

const FINGERPRINT_CONCURRENCY = 8;

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

type GitText = {
  text: string;
  error?: string | undefined;
};

type StatusSnapshot = {
  lines: string[];
  paths: string[];
  codes: Map<string, string>;
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

  const [head, status, unstagedDiffStat, stagedDiffStat, unstaged, staged, index] = await Promise.all([
    gitText(gitRoot, ["rev-parse", "HEAD"]),
    gitText(gitRoot, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "--untracked-files=all", "-z"]),
    gitText(gitRoot, ["diff", "--stat"]),
    gitText(gitRoot, ["diff", "--cached", "--stat"]),
    gitText(gitRoot, ["-c", "core.quotepath=false", "diff", "--name-status", "-z"]),
    gitText(gitRoot, ["-c", "core.quotepath=false", "diff", "--cached", "--name-status", "-z"]),
    gitText(gitRoot, ["-c", "core.quotepath=false", "ls-files", "--stage", "-z"])
  ]);
  const statusSnapshot = parseStatusPorcelain(status.text);
  const indexEntries = parseIndexEntries(index.text);
  const currentHead = head.text.trim();
  let committedFiles: GitText = { text: "" };
  let committedStat: GitText = { text: "" };
  if (sinceHead && currentHead && sinceHead !== currentHead) {
    [committedFiles, committedStat] = await Promise.all([
      gitText(gitRoot, ["-c", "core.quotepath=false", "diff", "--name-status", "-z", sinceHead, currentHead]),
      gitText(gitRoot, ["diff", "--stat", sinceHead, currentHead])
    ]);
  }
  const changedFiles = unique([
    ...statusSnapshot.paths,
    ...parseNameStatusPaths(unstaged.text),
    ...parseNameStatusPaths(staged.text)
  ]);
  const fingerprints = await fingerprintFiles(gitRoot, statusSnapshot.codes, indexEntries, changedFiles);
  const evidenceErrors = [
    head.error,
    status.error,
    unstagedDiffStat.error,
    stagedDiffStat.error,
    unstaged.error,
    staged.error,
    index.error,
    committedFiles.error,
    committedStat.error
  ].filter((value): value is string => Boolean(value));

  return {
    gitRoot,
    head: currentHead || null,
    status: statusSnapshot.lines,
    changedFiles,
    fingerprints,
    diffStat: [unstagedDiffStat.text.trim(), stagedDiffStat.text.trim()].filter(Boolean).join("\n"),
    committedChangedFiles: unique(parseNameStatusPaths(committedFiles.text)),
    committedDiffStat: committedStat.text.trim(),
    ...(evidenceErrors.length > 0 ? { error: evidenceErrors.join("; ") } : {})
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
    warnings.push("Worker changed paths outside the declared scope: " + outOfScopeChanges.join(", "));
  }
  if (["advice_only", "read_only"].includes(sideEffectPolicy) && changedFiles.length > 0) {
    warnings.push("Side-effect policy " + sideEffectPolicy + " was violated by workspace changes.");
  }
  if (after.error) warnings.push("Git evidence after execution is incomplete: " + after.error);
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
  return globRegExp(normalizedPattern).test(normalizedFile);
}

async function fingerprintFiles(
  root: string,
  statuses: Map<string, string>,
  indexEntries: Map<string, string>,
  files: string[]
): Promise<Record<string, string>> {
  const entries = await mapWithConcurrency(files, FINGERPRINT_CONCURRENCY, async (file) => {
    const fingerprint = await fingerprintFile(
      resolve(root, file),
      statuses.get(file) ?? "",
      indexEntries.get(file) ?? "missing"
    );
    return [file, fingerprint] as const;
  });
  return Object.fromEntries(entries);
}

async function fingerprintFile(filePath: string, status: string, indexEntry: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update("status\0");
  hash.update(status);
  hash.update("\0index\0");
  hash.update(indexEntry);
  hash.update("\0");

  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (isMissingError(error)) {
      hash.update("missing\0");
      return hash.digest("hex");
    }
    throw error;
  }

  if (metadata.isSymbolicLink()) {
    hash.update("symlink\0" + String(metadata.mode) + "\0");
    try {
      hash.update(await readlink(filePath, "utf8"));
    } catch (error) {
      if (isMissingError(error)) {
        hash.update("missing\0");
        return hash.digest("hex");
      }
      throw error;
    }
    return hash.digest("hex");
  }

  if (metadata.isFile()) {
    hash.update("file\0" + String(metadata.mode) + "\0");
    try {
      for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
      }
    } catch (error) {
      if (isMissingError(error)) {
        hash.update("missing\0");
        return hash.digest("hex");
      }
      throw error;
    }
    return hash.digest("hex");
  }

  const type = metadata.isDirectory() ? "directory" : "other";
  hash.update(type + "\0" + String(metadata.mode) + "\0");
  return hash.digest("hex");
}

function incrementalDiffStat(before: GitEvidence, after: GitEvidence, workingTreeFiles: string[]): string {
  const workingTreeStat = before.changedFiles.length === 0
    ? after.diffStat
    : workingTreeFiles.map((file) => file + " | changed during worker run").join("\n");
  return [workingTreeStat, after.committedDiffStat].filter(Boolean).join("\n");
}

async function gitText(root: string, args: string[]): Promise<GitText> {
  const result = await runCommand("git", ["-C", root, ...args], { timeoutMs: 10_000 }).catch((error: unknown) => ({
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    exitCode: null,
    timedOut: false
  }));
  if (result.exitCode !== 0) {
    return { text: result.stdout, error: result.stderr.trim() || "git " + args.join(" ") + " failed" };
  }
  return { text: result.stdout };
}

function parseStatusPorcelain(text: string): StatusSnapshot {
  const records = splitRecords(text);
  const lines: string[] = [];
  const paths: string[] = [];
  const codes = new Map<string, string>();
  for (let index = 0; index < records.length;) {
    const record = records[index++];
    if (!record || record.length < 3) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (path.length === 0) continue;
    paths.push(path);
    codes.set(path, code);
    if (isRenameCode(code)) {
      const original = records[index++];
      if (original) {
        paths.push(original);
        codes.set(original, code);
        lines.push(code + " " + original + " -> " + path);
      } else {
        lines.push(record);
      }
      continue;
    }
    lines.push(record);
  }
  return { lines, paths, codes };
}

function parseNameStatusPaths(text: string): string[] {
  if (!text.includes("\0")) {
    return text.split(/\r?\n/).flatMap((line) => {
      if (!line) return [];
      const separator = line.indexOf("\t");
      if (separator < 0) return [];
      const status = line.slice(0, separator);
      const path = line.slice(separator + 1);
      return isRenameCode(status) ? path.split("\t").filter(Boolean) : [path];
    });
  }

  const records = splitRecords(text);
  const paths: string[] = [];
  for (let index = 0; index < records.length;) {
    const status = records[index++];
    if (!status) continue;
    if (isRenameCode(status)) {
      const original = records[index++];
      const destination = records[index++];
      if (original) paths.push(original);
      if (destination) paths.push(destination);
      continue;
    }
    const path = records[index++];
    if (path) paths.push(path);
  }
  return paths;
}

function parseIndexEntries(text: string): Map<string, string> {
  const entries = new Map<string, string[]>();
  for (const record of splitRecords(text)) {
    const separator = record.indexOf("\t");
    if (separator < 0) continue;
    const metadata = record.slice(0, separator);
    const path = record.slice(separator + 1);
    const values = entries.get(path) ?? [];
    values.push(metadata);
    entries.set(path, values);
  }
  return new Map(
    [...entries].map(([path, values]) => [path, values.sort().join("|")])
  );
}

function splitRecords(text: string): string[] {
  return text.includes("\0")
    ? text.split("\0").filter((record) => record.length > 0)
    : text.split(/\r?\n/).filter((record) => record.length > 0);
}

function isRenameCode(code: string): boolean {
  return code.startsWith("R") || code.startsWith("C") || code.includes("R") || code.includes("C");
}

function globRegExp(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length;) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 2;
        while (pattern[index] === "*") index += 1;
        if (pattern[index] === "/") {
          index += 1;
          expression += "(?:[^/]+/)*";
        } else {
          expression += ".*";
        }
      } else {
        index += 1;
        expression += "[^/]*";
      }
      continue;
    }
    expression += escapeRegexCharacter(character);
    index += 1;
  }
  return new RegExp(expression + "$");
}

function escapeRegexCharacter(character: string): string {
  return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function isMissingError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

function unique(items: string[]): string[] {
  return [...new Set(items)].sort((left, right) => left.localeCompare(right));
}
