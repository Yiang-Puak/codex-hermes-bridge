import { describe, expect, it } from "vitest";
import { parseConfigText } from "../src/config.js";
import { resolveRoute, ResolverError } from "../src/resolver.js";

const yaml = `
version: 1
providers:
  openrouter:
    hermesProvider: openrouter
  deepseek:
    hermesProvider: deepseek
models:
  free-coder:
    provider: openrouter
    model: free/model
    costClass: free
  paid-coder:
    provider: deepseek
    model: deepseek/model
    costClass: paid
  disabled-coder:
    provider: openrouter
    model: disabled/model
    enabled: false
workers:
  coder:
    profile: executor
    model: free-coder
    role: implementation
    capabilities: [code-write, test]
  reviewer:
    profile: reviewer
    role: review
    capabilities: [code-review]
  paid:
    profile: paid
    model: paid-coder
    capabilities: [code-write]
teams:
  default:
    roles:
      coder: coder
      reviewer: reviewer
    maxParallel: 2
`;

const config = () => parseConfigText(yaml);

describe("resolveRoute", () => {
  it("resolves an exact worker to profile and pinned model", () => {
    const result = resolveRoute(config(), { worker: "coder" });

    expect(result.selected).toMatchObject({
      worker: "coder",
      profile: "executor",
      modelRef: "free-coder",
      provider: "openrouter",
      model: "free/model",
      modelSource: "worker_registry"
    });
  });

  it("resolves a team role deterministically", () => {
    const result = resolveRoute(config(), { team: "default", role: "reviewer" });

    expect(result.selected.worker).toBe("reviewer");
    expect(result.selected.modelSource).toBe("profile_default");
    expect(result.selected.why).toContain("team default role reviewer");
  });

  it("rejects missing or disabled models and missing providers", () => {
    expect(() => resolveRoute(config(), { worker: "missing" })).toThrowError(ResolverError);
    expect(() => resolveRoute(config(), { worker: "coder", modelOverride: "disabled-coder" })).toThrow(
      "missing or disabled"
    );

    const broken = parseConfigText(`
providers: {}
models:
  broken:
    provider: absent
    model: example/model
workers:
  coder:
    profile: executor
    model: broken
`);
    expect(() => resolveRoute(broken, { worker: "coder" })).toThrow("Provider 'absent'");
  });

  it("does not use a paid fallback when free capability routing has no match", () => {
    expect(() => resolveRoute(config(), { capabilities: ["code-write"], preferences: { costClass: "unknown" } })).toThrow(
      "No enabled worker"
    );
  });

  it("supports an explicit model override without mutating the worker", () => {
    const result = resolveRoute(config(), { worker: "coder", modelOverride: "paid-coder" });

    expect(result.selected.modelRef).toBe("paid-coder");
    expect(result.selected.modelSource).toBe("explicit_override");
    expect(config().workers.coder?.model).toBe("free-coder");
  });

  it("uses profile default only when the worker has no model reference", () => {
    const result = resolveRoute(config(), { worker: "reviewer" });

    expect(result.selected.modelRef).toBeNull();
    expect(result.selected.provider).toBeNull();
    expect(result.selected.model).toBeNull();
  });

  it("uses the configured default worker until another route is explicit", () => {
    const bridge = config();
    bridge.routing.defaultWorker = "coder";

    const defaultRoute = resolveRoute(bridge, { capabilities: ["code-review"] });
    expect(defaultRoute.selected.worker).toBe("coder");
    expect(defaultRoute.selected.why).toContain("default worker coder");
    expect(resolveRoute(bridge, { worker: "reviewer" }).selected.worker).toBe("reviewer");
    expect(resolveRoute(bridge, { role: "reviewer" }).selected.worker).toBe("reviewer");
  });
});
