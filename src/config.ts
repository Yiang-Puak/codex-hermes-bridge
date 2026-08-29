import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { BridgeConfigSchema, type BridgeConfig } from "./types.js";

const DEFAULT_CONFIG_PATH = join(homedir(), ".codex-hermes-bridge", "team.yaml");

export function getConfigPath(explicitPath?: string): string {
  return explicitPath ?? process.env.CODEX_HERMES_BRIDGE_CONFIG ?? DEFAULT_CONFIG_PATH;
}

export function loadConfig(explicitPath?: string): BridgeConfig {
  const configPath = getConfigPath(explicitPath);
  const raw = existsSync(configPath) ? parseConfigFile(configPath) : {};
  return BridgeConfigSchema.parse(raw);
}

export function parseConfigText(text: string, format: "yaml" | "json" = "yaml"): BridgeConfig {
  const raw = format === "json" ? JSON.parse(text) : YAML.parse(text);
  return BridgeConfigSchema.parse(raw);
}

export function writeStarterConfig(targetPath?: string): string {
  const destination = getConfigPath(targetPath);
  if (existsSync(destination)) {
    throw new Error(`Config already exists: ${destination}`);
  }

  const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "team.yaml");
  const source = readFileSync(sourcePath, "utf8");
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, source, { encoding: "utf8", mode: 0o600 });
  return destination;
}

function parseConfigFile(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  return path.toLowerCase().endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
}
