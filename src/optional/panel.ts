import { randomUUID } from "node:crypto";
import { getWorker } from "../registry.js";
import type { BridgeConfig } from "../types.js";
import { runWorker, type WorkerRunRequest } from "../execution/worker-runner.js";
import type { TaskContract } from "../execution/task-contract.js";
import type { WorkerRunResult } from "../execution/result.js";
import { HermesCliProvider } from "../providers/hermes-cli.js";

export type PanelRequest = {
  cwd: string;
  task: TaskContract;
  workers: string[];
  maxWorkers?: number | undefined;
};

export type PanelResult = {
  schemaVersion: "1.0";
  runId: string;
  status: "completed" | "partial" | "failed";
  responses: Array<{
    worker: string;
    result: WorkerRunResult;
  }>;
  warnings: string[];
  errors: string[];
};

export async function runPanel(config: BridgeConfig, request: PanelRequest): Promise<PanelResult> {
  if (!config.panel.enabled) {
    return {
      schemaVersion: "1.0",
      runId: randomUUID(),
      status: "failed",
      responses: [],
      warnings: [],
      errors: ["Panel support is disabled. Set panel.enabled: true in the bridge config."]
    };
  }
  const workerLimit = Math.max(1, Math.min(request.maxWorkers ?? config.panel.maxWorkers, config.panel.maxWorkers));
  const workers = [...new Set(request.workers)].slice(0, workerLimit);
  const warnings: string[] = [];
  const runnable: string[] = [];
  for (const worker of workers) {
    const entry = getWorker(config, worker);
    if (entry && !["advice_only", "read_only"].includes(entry.sideEffectPolicy)) {
      warnings.push(`Panel worker '${worker}' is write-capable; it was not run.`);
      continue;
    }
    runnable.push(worker);
  }

  const responses = new Array<PanelResult["responses"][number]>(runnable.length);
  const provider = new HermesCliProvider(config);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(workerLimit, Math.max(1, runnable.length)) }, async () => {
      while (true) {
        const index = nextIndex++;
        const worker = runnable[index];
        if (!worker) return;
        const result = await runWorker(config, {
          worker,
          cwd: request.cwd,
          workspaceMode: "shared",
          task: request.task
        } satisfies WorkerRunRequest, provider);
        responses[index] = { worker, result };
      }
    })
  );
  const failed = responses.filter(({ result }) => result.status !== "completed").length;
  return {
    schemaVersion: "1.0",
    runId: randomUUID(),
    status: responses.length === 0 ? "failed" : failed === 0 ? "completed" : "partial",
    responses,
    warnings,
    errors: responses.length === 0 ? ["No read-only panel worker was available."] : []
  };
}
