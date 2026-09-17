import { spawn } from "node:child_process";
import type { CommandResult } from "./types.js";

/** Keep ordinary CLI output bounded without silently changing its contents. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const FORCE_KILL_AFTER_MS = 5_000;

export class CommandOutputLimitError extends Error {
  readonly name = "CommandOutputLimitError";

  constructor(
    readonly stream: "stdout" | "stderr",
    readonly limitBytes: number
  ) {
    super(`Command ${stream} exceeded the ${limitBytes}-byte output limit.`);
  }
}

export class CommandAbortError extends Error {
  readonly name = "AbortError";

  constructor() {
    super("Command execution was aborted.");
  }
}

export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    timeoutMs?: number | undefined;
    input?: string | undefined;
    signal?: AbortSignal | undefined;
    maxOutputBytes?: number | undefined;
  } = {}
): Promise<CommandResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.reject(new TypeError("maxOutputBytes must be a positive safe integer."));
  }
  if (options.signal?.aborted) return Promise.reject(new CommandAbortError());

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputLimitError: CommandOutputLimitError | undefined;
    let streamError: Error | undefined;
    let processError: Error | undefined;
    let settled = false;
    let terminationRequested = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (abortListener) options.signal?.removeEventListener("abort", abortListener);
    };

    const terminate = (): void => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may have exited between the state check and kill().
      }
      killTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // The close event remains the source of truth for process completion.
        }
      }, FORCE_KILL_AFTER_MS);
    };

    const appendOutput = (stream: "stdout" | "stderr", chunk: string): void => {
      if (outputLimitError) return;
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (stream === "stdout") {
        stdoutBytes += bytes;
        if (stdoutBytes > maxOutputBytes) {
          outputLimitError = new CommandOutputLimitError(stream, maxOutputBytes);
          terminate();
          return;
        }
        stdout += chunk;
      } else {
        stderrBytes += bytes;
        if (stderrBytes > maxOutputBytes) {
          outputLimitError = new CommandOutputLimitError(stream, maxOutputBytes);
          terminate();
          return;
        }
        stderr += chunk;
      }
    };

    const settle = (error?: Error, result?: CommandResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (result) resolve(result);
    };

    const handleStreamError = (error: Error): void => {
      if (settled) return;
      streamError = error;
      terminate();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => appendOutput("stdout", chunk));
    child.stderr.on("data", (chunk: string) => appendOutput("stderr", chunk));
    child.stdin.on("error", handleStreamError);
    child.stdout.on("error", handleStreamError);
    child.stderr.on("error", handleStreamError);
    child.on("error", (error) => {
      if (!child.pid) {
        settle(error);
        return;
      }
      processError = error;
      terminate();
    });
    child.on("close", (exitCode) => {
      if (aborted) {
        settle(new CommandAbortError());
      } else if (outputLimitError) {
        settle(outputLimitError);
      } else if (timedOut) {
        settle(undefined, { stdout, stderr, exitCode, timedOut });
      } else if (streamError) {
        settle(streamError);
      } else if (processError) {
        settle(processError);
      } else {
        settle(undefined, { stdout, stderr, exitCode, timedOut });
      }
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
    }
    if (options.signal) {
      abortListener = () => {
        aborted = true;
        terminate();
      };
      options.signal.addEventListener("abort", abortListener, { once: true });
      if (options.signal.aborted) abortListener();
    }

    if (options.input !== undefined) {
      try {
        child.stdin.write(options.input);
      } catch (error) {
        handleStreamError(error instanceof Error ? error : new Error(String(error)));
      }
    }
    try {
      child.stdin.end();
    } catch (error) {
      handleStreamError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
