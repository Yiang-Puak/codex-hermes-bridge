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
      "Inspect the relevant implementation.",
      "Determine the smallest complete change.",
      "Implement it.",
      "Add or update tests where appropriate.",
      "Run targeted validation.",
      "Debug failures caused by the change.",
      "Re-run validation.",
      "Inspect the resulting diff."
    ]),
    "",
    "ACCEPTANCE CRITERIA",
    ...numberedOrNone(task.acceptanceCriteria),
    "",
    "VALIDATION",
    ...numberedOrNone(task.validation),
    "",
    "FINAL RESPONSE CONTRACT",
    "Return structured evidence only:",
    "- files changed",
    "- implementation summary",
    "- commands run",
    "- pass/fail result",
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
