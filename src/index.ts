#!/usr/bin/env node

import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getConfigPath, loadConfig, writeStarterConfig } from "./config.js";
import { HermesCliProvider } from "./providers/hermes-cli.js";
import { publicRegistry } from "./registry.js";
import { resolveRoute, ResolverError } from "./resolver.js";
import { runWorker } from "./execution/worker-runner.js";
import { runTeam } from "./execution/team-runner.js";
import { TaskContractSchema } from "./execution/task-contract.js";
import { WorkspaceModeSchema } from "./types.js";
import { runPanel } from "./optional/panel.js";

const cliCommand = process.argv[2];

if (cliCommand && cliCommand !== "serve") {
  process.exit(await runCli(cliCommand));
}

const server = new McpServer({
  name: "codex-hermes-bridge",
  version: "0.4.0"
});

server.tool("hermes_bridge_health", {}, async () => {
  const configPath = getConfigPath();
  const config = loadConfig(configPath);
  const provider = new HermesCliProvider(config);
  const defaultTeam = config.teams[config.routing.defaultTeam];
  const defaultRole = defaultTeam ? Object.keys(defaultTeam.roles).sort((left, right) => left.localeCompare(right))[0] : undefined;
  let activeDefaultRoute: ReturnType<typeof resolveRoute>["selected"] | null = null;
  let routeWarning: string | undefined;
  if (config.routing.defaultWorker) {
    try {
      activeDefaultRoute = resolveRoute(config, {
        team: config.routing.defaultTeam,
        worker: config.routing.defaultWorker
      }).selected;
    } catch (error) {
      routeWarning = error instanceof Error ? error.message : String(error);
    }
  } else if (defaultRole) {
    try {
      activeDefaultRoute = resolveRoute(config, { team: config.routing.defaultTeam, role: defaultRole }).selected;
    } catch (error) {
      routeWarning = error instanceof Error ? error.message : String(error);
    }
  } else {
    routeWarning = `Default team '${config.routing.defaultTeam}' has no role mapping.`;
  }
  const hermes = await provider.health().catch((error: unknown) => ({
    ok: false,
    version: null,
    runtime: config.hermes.runtime,
    error: error instanceof Error ? error.message : String(error)
  }));
  return jsonContent({
    ok: hermes.ok,
    runtime: config.hermes.runtime,
    hermesVersion: hermes.version,
    hermes,
    configPath,
    activeDefaultRoute,
    teams: Object.keys(config.teams).length,
    workers: Object.keys(config.workers).length,
    models: Object.keys(config.models).length,
    providers: Object.keys(config.providers).length,
    warnings: [
      ...(configPath && !existsSync(configPath) ? ["Config file does not exist; defaults are active."] : []),
      ...(routeWarning ? [`Default route unavailable: ${routeWarning}`] : []),
      ...(hermes.ok ? [] : ["Hermes runtime is not healthy; no model was called."])
    ]
  });
});

server.tool("hermes_team_list", {}, async () => {
  const config = loadConfig();
  const provider = new HermesCliProvider(config);
  const profiles = await provider.discoverProfiles().catch(() => []);
  const resolvedRoutes = Object.keys(config.workers)
    .sort((left, right) => left.localeCompare(right))
    .map((worker) => {
      try {
        return resolveRoute(config, { worker }).selected;
      } catch (error) {
        return {
          worker,
          ok: false,
          code: error instanceof ResolverError ? error.code : "route_error",
          error: error instanceof Error ? error.message : String(error)
        };
      }
    });
  return jsonContent({ ...publicRegistry(config), profiles, resolvedRoutes });
});

server.tool(
  "hermes_team_route",
  {
    team: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    worker: z.string().min(1).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    preferences: z
      .object({ costClass: z.enum(["free", "paid", "unknown"]).optional() })
      .optional(),
    modelOverride: z.string().min(1).optional()
  },
  async (input) => {
    try {
      return jsonContent(resolveRoute(loadConfig(), input));
    } catch (error) {
      if (error instanceof ResolverError) {
        return jsonContent({ ok: false, code: error.code, error: error.message });
      }
      throw error;
    }
  }
);

server.tool(
  "hermes_worker_run",
  {
    worker: z.string().min(1).optional(),
    team: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    modelOverride: z.string().min(1).optional(),
    cwd: z.string().min(1),
    task: TaskContractSchema,
    workspaceMode: WorkspaceModeSchema.optional(),
    timeoutMs: z.number().int().positive().optional()
  },
  async (input) => jsonContent(await runWorker(loadConfig(), input))
);

server.tool(
  "hermes_team_run",
  {
    team: z.string().min(1),
    mode: z.literal("parallel"),
    maxParallel: z.number().int().positive().optional(),
    tasks: z.array(
      z.object({
        id: z.string().min(1),
        worker: z.string().min(1).optional(),
        role: z.string().min(1).optional(),
        capabilities: z.array(z.string().min(1)).optional(),
        modelOverride: z.string().min(1).optional(),
        cwd: z.string().min(1),
        task: TaskContractSchema,
        workspaceMode: WorkspaceModeSchema.optional()
      })
    ).min(1)
  },
  async (input) => jsonContent(await runTeam(loadConfig(), input))
);

if (loadConfig().panel.enabled) {
  server.tool(
    "hermes_panel_run",
    {
      cwd: z.string().min(1),
      workers: z.array(z.string().min(1)).min(1),
      maxWorkers: z.number().int().positive().optional(),
      task: TaskContractSchema
    },
    async (input) => jsonContent(await runPanel(loadConfig(), input))
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);

async function runCli(command: string): Promise<number> {
  switch (command) {
    case "--help":
    case "-h":
    case "help":
      printHelp();
      return 0;
    case "init-config":
      return initConfig(process.argv[3]);
    case "doctor":
      return doctor();
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      return 1;
  }
}

function initConfig(targetPath?: string): number {
  try {
    console.log(`Created config: ${writeStarterConfig(targetPath)}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function doctor(): Promise<number> {
  const configPath = getConfigPath();
  try {
    const config = loadConfig(configPath);
    const provider = new HermesCliProvider(config);
    const hermes = await awaitHealth(provider);
    const profiles = await awaitProfiles(provider);
    console.log(
      JSON.stringify(
        {
          ok: hermes.ok,
          configPath,
          node: process.version,
          runtime: config.hermes,
          hermes,
          profiles,
          configured: {
            providers: Object.keys(config.providers).length,
            models: Object.keys(config.models).length,
            workers: Object.keys(config.workers).length,
            teams: Object.keys(config.teams).length
          },
          probe: "not-run",
          warnings: existsSync(configPath) ? [] : ["Config file does not exist; defaults are active."]
        },
        null,
        2
      )
    );
    return hermes.ok ? 0 : 1;
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          configPath,
          error: error instanceof Error ? error.message : String(error)
        },
        null,
        2
      )
    );
    return 1;
  }
}

async function awaitHealth(provider: HermesCliProvider) {
  return provider.health().catch((error: unknown) => ({
    ok: false,
    version: null,
    runtime: provider.getRuntime().kind,
    error: error instanceof Error ? error.message : String(error)
  }));
}

async function awaitProfiles(provider: HermesCliProvider) {
  return provider.discoverProfiles().catch(() => []);
}

function printHelp(): void {
  console.log(`Codex Hermes Bridge

Usage:
  codex-hermes-bridge              Run MCP server over stdio
  codex-hermes-bridge serve        Run MCP server over stdio
  codex-hermes-bridge init-config  Create a starter team config
  codex-hermes-bridge doctor       Validate config without calling a model

Environment:
  CODEX_HERMES_BRIDGE_CONFIG       Path to team.yaml
`);
}

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
