import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseConfigText } from "../src/config.js";

describe("BridgeConfigSchema", () => {
  it("parses the minimal config with safe defaults", () => {
    const config = parseConfigText("version: 1\n");

    expect(config.version).toBe(1);
    expect(config.hermes.runtime).toBe("direct");
    expect(config.routing.allowPaidFallback).toBe(false);
    expect(config.safety.acceptHooks).toBe(false);
    expect(config.workers).toEqual({});
  });

  it("parses the public worker registry shape", () => {
    const config = parseConfigText(`
version: 1
providers:
  local:
    hermesProvider: local
models:
  worker-model:
    provider: local
    model: example/model
workers:
  coder:
    profile: executor
    model: worker-model
    runtime: direct
    command: C:/Hermes/hermes.exe
    maxTurns: 30
    capabilities: [code-write]
teams:
  default:
    roles:
      coder: coder
`);

    expect(config.workers.coder?.profile).toBe("executor");
    expect(config.workers.coder?.maxTurns).toBe(30);
    expect(config.workers.coder?.runtime).toBe("direct");
    expect(config.workers.coder?.command).toBe("C:/Hermes/hermes.exe");
    expect(config.models["worker-model"]?.provider).toBe("local");
    expect(config.teams.default?.roles.coder).toBe("coder");
  });

  it("uses DeepSeek V4.1 Flash as the default example route", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const config = parseConfigText(readFileSync(resolve(repoRoot, "examples", "team.yaml"), "utf8"));
    expect(config.routing.defaultWorker).toBe("quick");
    expect(config.workers.quick?.model).toBe("deepseek-v4.1-flash");
    expect(config.models["deepseek-v4.1-flash"]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4.1-flash",
      enabled: true
    });
  });

  it.each([
    ["execution.collectGitEvidence", "execution:\n  collectGitEvidence: false"],
    ["safety.acceptHooks", "safety:\n  acceptHooks: true"],
    ["execution.keepArtifacts", "execution:\n  keepArtifacts: true"],
    ["routing.allowPaidFallback", "routing:\n  allowPaidFallback: true"],
    ["kanban.enabled", "kanban:\n  enabled: true"]
  ])("rejects unsupported %s", (field, text) => {
    expect(() => parseConfigText(text)).toThrow(field);
  });
});
