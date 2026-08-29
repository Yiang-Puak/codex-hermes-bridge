import { z } from "zod";
import { RuntimeKindSchema, WorkspaceModeSchema } from "../types.js";

export const RunStatusSchema = z.enum([
  "prepared",
  "running",
  "completed",
  "failed",
  "timed_out",
  "routing_failed",
  "policy_violation",
  "invalid_result",
  "blocked"
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const WorkerRunResultSchema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.string().min(1),
  status: RunStatusSchema,
  taskId: z.string().min(1),
  team: z.string().min(1),
  worker: z.string().min(1),
  routing: z.object({
    profile: z.string().min(1),
    modelRef: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    modelSource: z.enum(["worker_registry", "profile_default", "explicit_override", "none"])
  }),
  runtime: z.object({
    kind: RuntimeKindSchema,
    distro: z.string().nullable(),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean()
  }),
  workspace: z.object({
    mode: WorkspaceModeSchema,
    cwd: z.string().min(1),
    gitRoot: z.string().nullable(),
    headBefore: z.string().nullable(),
    headAfter: z.string().nullable(),
    worktreePath: z.string().nullable().optional(),
    branch: z.string().nullable().optional()
  }),
  evidence: z.object({
    changedFiles: z.array(z.string()),
    diffStat: z.string(),
    statusBefore: z.array(z.string()),
    statusAfter: z.array(z.string()),
    outOfScopeChanges: z.array(z.string())
  }),
  workerReport: z.object({ text: z.string() }),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
  startedAt: z.string(),
  finishedAt: z.string()
});
export type WorkerRunResult = z.infer<typeof WorkerRunResultSchema>;

export function redactSensitive(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9._~-]{16,}\b/giu, "[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[A-Za-z0-9._~+\/-]+/giu, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*")([^"]*)"/giu, '$1[REDACTED]"')
    .replace(/((?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*')([^']*)'/giu, "$1[REDACTED]'")
    .replace(/((?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*)[^\s"']+/giu, "$1[REDACTED]");
}
