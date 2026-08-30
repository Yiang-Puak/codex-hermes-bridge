import { describe, expect, it } from "vitest";
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
    maxTurns: 30
    capabilities: [code-write]
teams:
  default:
    roles:
      coder: coder
`);

    expect(config.workers.coder?.profile).toBe("executor");
    expect(config.workers.coder?.maxTurns).toBe(30);
    expect(config.models["worker-model"]?.provider).toBe("local");
    expect(config.teams.default?.roles.coder).toBe("coder");
  });
});
