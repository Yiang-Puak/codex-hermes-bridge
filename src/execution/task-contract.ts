import { z } from "zod";

export const TaskScopeSchema = z.object({
  allowedPaths: z.array(z.string().min(1)).default([]),
  forbiddenPaths: z.array(z.string().min(1)).default([])
});

export const TaskContractSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  context: z.string(),
  requirements: z.array(z.string().min(1)),
  scope: TaskScopeSchema,
  acceptanceCriteria: z.array(z.string().min(1)),
  validation: z.array(z.string().min(1)),
  dependsOn: z.array(z.string().min(1)).optional(),
  ownership: z.array(z.string().min(1)).optional(),
  knownRisks: z.array(z.string().min(1)).optional(),
  constraints: z.array(z.string().min(1)).optional(),
  expectedOutput: z.string().optional()
});

export type TaskContract = z.infer<typeof TaskContractSchema>;

export function buildWorkerPrompt(
  task: TaskContract,
  details: {
    role: string;
    worker: string;
    profile: string;
    currentState: string;
    sideEffectPolicy: string;
    allowWorkerCommits: boolean;
  }
): string {
  return [
    "You are the implementation worker for this task.",
    "You are being invoked by Codex/Sol, which owns planning and final review.",
    "You own execution of the assigned task.",
    "",
    "ROLE",
    `${details.role} (worker=${details.worker}, profile=${details.profile})`,
    "",
    "OBJECTIVE",
    task.objective,
    "",
    "CONTEXT",
    task.context,
    "",
    "CURRENT STATE",
    details.currentState,
    "",
    "EXECUTION POLICY",
    `Side-effect policy: ${details.sideEffectPolicy}`,
    `Worker commits allowed: ${details.allowWorkerCommits ? "yes" : "no"}`,
    "The policy is enforced by the bridge's evidence checks; it is not a sandbox.",
    "Do not perform external side effects automatically.",
    "",
    "SCOPE / OWNERSHIP",
    "Allowed paths:",
    ...listOrNone(task.scope.allowedPaths),
    "Forbidden paths:",
    ...listOrNone(task.scope.forbiddenPaths),
    ...(task.ownership ? ["Ownership:", ...listOrNone(task.ownership)] : []),
    "Do not intentionally modify unrelated files.",
    "Do not revert pre-existing user changes.",
    "",
    "REQUIREMENTS",
    ...numberedOrNone(task.requirements),
    "",
    "CONSTRAINTS",
    ...numberedOrNone([
      "Preserve existing architecture unless the task contract explicitly changes it.",
      "Prefer existing abstractions over parallel implementations.",
      "Do not remove tests to make the suite pass.",
      "Do not suppress legitimate validation failures.",
      "Do not commit or push unless the task contract explicitly allows it.",
      "Do not perform destructive git operations.",
      ...(task.constraints ?? []),
      ...(task.knownRisks ? [`Known risks: ${task.knownRisks.join("; ")}`] : [])
    ]),
    "",
    "EXECUTION PROCEDURE",
    ...numberedOrNone([
      "Start with allowedPaths and ownership. Do not recursively scan unrelated directories; read another file only for a named dependency needed by this task.",
      "Determine the smallest complete change.",
      "Implement it.",
      "Add or update tests where appropriate.",
      "Run the listed validation once. On a compile or test failure, report it immediately unless one obvious local correction is sufficient; do not loop through repeated broad validation.",
      "Use one simple command per invocation. Avoid unrelated cleanup, recursive deletion, and line-ending rewrites.",
      "Do not create temporary test scripts unless the existing test system cannot verify a required behavior.",
      "Inspect the resulting diff once before reporting."
    ]),
    "",
    "ACCEPTANCE CRITERIA",
    ...numberedOrNone(task.acceptanceCriteria),
    "",
    "VALIDATION",
    ...numberedOrNone(task.validation),
    "",
    "FINAL RESPONSE CONTRACT",
    "Return at most 1200 characters of structured evidence:",
    "- files changed",
    "- validation commands and pass/fail result",
    "- blockers",
    "- residual risk",
    ...(task.expectedOutput ? ["", "EXPECTED OUTPUT", task.expectedOutput] : [])
  ].join("\n");
}

function numberedOrNone(items: string[]): string[] {
  return items.length > 0 ? items.map((item, index) => `${index + 1}. ${item}`) : ["- none specified"];
}

function listOrNone(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- none specified"];
}
