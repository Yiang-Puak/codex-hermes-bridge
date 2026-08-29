import { z } from "zod";

export const RuntimeKindSchema = z.enum(["direct", "wsl"]);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

export const QueryModeSchema = z.enum(["auto", "query", "query-file"]);
export type QueryMode = z.infer<typeof QueryModeSchema>;

export const SideEffectPolicySchema = z.enum([
  "advice_only",
  "read_only",
  "local_files_allowed",
  "external_side_effects_need_approval",
  "external_side_effects_allowed"
]);
export type SideEffectPolicy = z.infer<typeof SideEffectPolicySchema>;

export const WorkspaceModeSchema = z.enum(["shared", "worktree"]);
export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;

export const CostClassSchema = z.enum(["free", "paid", "unknown"]);
export type CostClass = z.infer<typeof CostClassSchema>;

export const ProviderSchema = z.object({
  hermesProvider: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).default([])
});
export type ProviderConfig = z.infer<typeof ProviderSchema>;

export const ModelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  enabled: z.boolean().default(true),
  costClass: CostClassSchema.default("unknown"),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional()
});
export type ModelConfig = z.infer<typeof ModelSchema>;

export const WorkerSchema = z.object({
  profile: z.string().min(1),
  model: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  description: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  toolsets: z.array(z.string()).default([]),
  sideEffectPolicy: SideEffectPolicySchema.default("read_only"),
  timeoutMs: z.number().int().positive().optional(),
  enabled: z.boolean().default(true)
});
export type WorkerConfig = z.infer<typeof WorkerSchema>;

export const TeamSchema = z.object({
  description: z.string().optional(),
  roles: z.record(z.string(), z.string().min(1)).default({}),
  maxParallel: z.number().int().positive().default(1)
});
export type TeamConfig = z.infer<typeof TeamSchema>;

export const BridgeConfigSchema = z.object({
  version: z.number().int().positive().default(1),
  hermes: z
    .object({
      runtime: RuntimeKindSchema.default("direct"),
      command: z.string().min(1).default("hermes"),
      distro: z.string().min(1).optional(),
      queryMode: QueryModeSchema.default("auto"),
      timeoutMs: z.number().int().positive().default(900_000),
      defaultToolsets: z.array(z.string()).default([]),
      source: z.string().min(1).default("tool")
    })
    .default({
      runtime: "direct",
      command: "hermes",
      queryMode: "auto",
      timeoutMs: 900_000,
      defaultToolsets: [],
      source: "tool"
    }),
  providers: z.record(z.string(), ProviderSchema).default({}),
  models: z.record(z.string(), ModelSchema).default({}),
  workers: z.record(z.string(), WorkerSchema).default({}),
  teams: z.record(z.string(), TeamSchema).default({}),
  routing: z
    .object({
      defaultTeam: z.string().min(1).default("default"),
      defaultWorker: z.string().min(1).optional(),
      allowPaidFallback: z.boolean().default(false),
      allowModelOverride: z.boolean().default(true)
    })
    .default({
      defaultTeam: "default",
      allowPaidFallback: false,
      allowModelOverride: true
    }),
  execution: z
    .object({
      defaultWorkspaceMode: WorkspaceModeSchema.default("shared"),
      parallelWriteWorkspaceMode: WorkspaceModeSchema.default("worktree"),
      failFast: z.boolean().default(false),
      maxParallel: z.number().int().positive().default(3),
      collectGitEvidence: z.boolean().default(true),
      allowWorkerCommits: z.boolean().default(false),
      keepArtifacts: z.boolean().default(false)
    })
    .default({
      defaultWorkspaceMode: "shared",
      parallelWriteWorkspaceMode: "worktree",
      failFast: false,
      maxParallel: 3,
      collectGitEvidence: true,
      allowWorkerCommits: false,
      keepArtifacts: false
    }),
  safety: z
    .object({
      defaultSideEffectPolicy: SideEffectPolicySchema.default("local_files_allowed"),
      allowedWorkspaceRoots: z.array(z.string()).default([]),
      acceptHooks: z.boolean().default(false)
    })
    .default({
      defaultSideEffectPolicy: "local_files_allowed",
      allowedWorkspaceRoots: [],
      acceptHooks: false
    }),
  panel: z
    .object({
      enabled: z.boolean().default(false),
      maxWorkers: z.number().int().positive().default(4)
    })
    .default({ enabled: false, maxWorkers: 4 }),
  kanban: z
    .object({
      enabled: z.boolean().default(false)
    })
    .default({ enabled: false })
});
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

export type ResolvedRoute = {
  team: string;
  role: string;
  worker: string;
  profile: string;
  modelRef: string | null;
  provider: string | null;
  model: string | null;
  modelSource: "worker_registry" | "profile_default" | "explicit_override" | "none";
  why: string;
};
