import { describe, expect, it } from "vitest";
import { redactSensitive, WorkerRunResultSchema } from "../src/execution/result.js";

describe("worker result contract", () => {
  it("redacts credential-shaped output and validates the result shape", () => {
    const token = ["sk", "or", "v1", "abcdefghijklmnopqrstuvwxyz"].join("-");
    expect(redactSensitive(`Authorization: Bearer abc.def api_key="secret-value" ${token}`)).toBe(
      "Authorization: Bearer [REDACTED] api_key=\"[REDACTED]\" [REDACTED]"
    );
    expect(
      WorkerRunResultSchema.parse({
        schemaVersion: "1.0",
        runId: "run",
        status: "completed",
        taskId: "task",
        team: "default",
        worker: "coder",
        routing: {
          profile: "executor",
          modelRef: "model",
          provider: "provider",
          model: "provider/model",
          modelSource: "worker_registry"
        },
        runtime: { kind: "direct", distro: null, exitCode: 0, timedOut: false },
        workspace: { mode: "shared", cwd: "C:/repo", gitRoot: "C:/repo", headBefore: "a", headAfter: "a" },
        evidence: { changedFiles: [], diffStat: "", statusBefore: [], statusAfter: [], outOfScopeChanges: [] },
        workerReport: { text: "ok" },
        warnings: [],
        errors: [],
        startedAt: "now",
        finishedAt: "now"
      }).status
    ).toBe("completed");
  });
});
