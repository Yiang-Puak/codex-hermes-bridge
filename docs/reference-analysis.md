# Reference Analysis

Reference repository: AlekseiUL/codex-plus-hermes-team
Reference branch: main
Reference commit: `ff892ab5238af227981bb3f3bc8ba588bdf0ccd3`
Analyzed at: 2026-08-26T17:34:53+08:00
Purpose: architecture and implementation reference only

## 1. Reference revision

The reference was cloned into a sibling directory outside this repository. Its
checkout was clean at the recorded commit. No product changes were made in the
reference checkout. The runtime inventory at that revision was collected from
the actual filesystem rather than from the PRD's static list.

Reference top-level implementation shape:

```text
src/command.ts
src/config.ts
src/index.ts
src/policy.ts
src/registry.ts
src/router.ts
src/structured.ts
src/types.ts
src/providers/hermes-cli.ts
tests/config.test.ts
tests/hermes-cli.test.ts
tests/router.test.ts
tests/structured.test.ts
skills/hermes-team/SKILL.md
examples/team.yaml
examples/codex-config.example.toml
examples/claude-code-config.example.json
```

The project is MIT licensed. Its implementation is an MCP server intended to
consult configured Hermes profiles; it is not an execution worker bridge and is
not a Codex model provider.

## 2. Reference baseline test results

The commands were run against the recorded checkout without modifying source:

- `npm ci`: PASS. The prepare build ran successfully; npm reported 143 packages
  added and 10 audit findings (2 low, 2 moderate, 6 high). The audit output is
  an upstream dependency signal, not a reason to modify the reference checkout.
- `npm test -- --run`: PASS — 4 files, 8 tests.
- `npm run typecheck`: PASS.
- `npm run build`: PASS, including the executable-bit postbuild step.
- `git diff --check`: PASS.

The reference baseline is therefore usable for architectural comparison. Its
tests are intentionally small and do not cover real Hermes execution, process
tree termination, worktree isolation, or MCP tool calls over stdio.

## 3. Runtime source inventory

### `src/index.ts`

Creates a local `McpServer` over `StdioServerTransport`, registers the health,
agent, routing, specialist, panel, role-discovery, and optional Kanban tools,
and provides `init-config` and `doctor` CLI commands. Each tool creates a
configuration-backed `HermesCliProvider` and serializes its result as MCP text
JSON. The reference keeps final semantic synthesis in the coding assistant,
although its panel helper does deterministic heading extraction.

### `src/types.ts`

Uses Zod for side-effect policy, agent, bridge configuration, command result,
specialist input/result, and route decision types. The schema defaults favor
`advice_only`, local `hermes`, a 10-minute timeout, discovery enabled, and
Kanban disabled. Agents are profile-oriented and may carry role, capabilities,
cwd, toolsets, and metadata.

### `src/config.ts`

Resolves an explicit path first, then supported environment variables, then a
home-directory default. It parses JSON or YAML and applies selected environment
overrides for the Hermes command, cwd, and discovery prefix. This is a compact
and useful configuration-loading pattern, but the v2 bridge needs separate
provider/model/team/worker registries and stricter path validation.

### `src/command.ts`

Wraps `child_process.spawn` with captured stdout/stderr, cwd/env overrides, and
timeout-triggered termination. It is a useful base but only kills the direct
child, does not accept a prompt through stdin, does not report timeout state,
and does not provide a process-group/process-tree contract.

### `src/providers/hermes-cli.ts`

Implements `hermes --version`, `hermes profile list`, one-shot profile calls,
and optional Kanban commands. It resolves a configured profile's cwd/toolsets
and prepends a side-effect policy to the prompt. Profile-table parsing is
deterministic and tolerant of display glyphs. The one-shot invocation is
argument-array based, but the reference main branch does not pin model/provider
and passes the whole prompt as a command-line argument.

### `src/registry.ts`

Merges discovered profiles with configured agents. Explicit configured entries
override discovered metadata; disabled configured entries remove profiles; the
result is sorted by profile. This precedence rule is appropriate for a v2
registry, but v2 must resolve a Worker/Team contract rather than only a profile.

### `src/router.ts`

Tokenizes English and Russian task text, expands hand-written stems to aliases,
scores profile metadata/capabilities, and falls back to configured defaults or
the first active profiles. It returns selected agents, score details,
confidence, route mode, and explanations. This is explainable but duplicates
planning intelligence that belongs to Sol/Codex and is not suitable as the
primary v2 route selector.

### `src/policy.ts`

Resolves a default side-effect policy and turns it into prompt text. The policy
is explicitly described as a guardrail rather than an OS sandbox. v2 keeps the
same honesty requirement while adding workspace and allowed-path evidence.

### `src/structured.ts`

Builds role-discovery and panel prompts, normalizes JSON role responses,
extracts fixed Markdown panel headings, infers evidence-gap phrases, and
collects a Kanban result. The useful part is the insistence on typed,
Codex-facing result shapes; the v2 bridge must not use this module to make
model-based semantic decisions inside the transport layer.

## 4. MCP tool inventory

The reference registers these tools:

| Tool | Reference behavior | v2 decision |
|---|---|---|
| `hermes_team_health` | Hermes version plus config flags | Replace with `hermes_bridge_health` and explicit runtime/profile/model health |
| `hermes_team_list_agents` | Merge configured and discovered profiles | Replace with team/worker registry listing |
| `hermes_team_route` | Keyword score and fallback route | Replace with explicit team/worker/capability resolver; Sol remains planner |
| `hermes_team_ask_agent` | Advice-oriented one-shot profile call | Replace with `hermes_worker_run` using a Task Contract |
| `hermes_team_discover_roles` | Parallel role JSON prompts | Keep the concept as optional discovery/cache, not the execution core |
| `hermes_team_ask_panel` | Parallel specialist advice plus heading synthesis | Adapt as optional `hermes_panel_run`, preserving raw independent results |
| `hermes_team_inspect_agent` | Advice-only role inspection | Fold into worker/registry health or optional discovery |
| `hermes_team_create_task` | Optional Hermes Kanban create | Register only when Kanban is enabled in a later phase |
| `hermes_team_get_task` | Optional Kanban show | Register only when Kanban is enabled |
| `hermes_team_collect_result` | Optional Kanban result normalization | Register only when Kanban is enabled |

The v2 P0 surface is deliberately smaller: health, team list, team route, worker
run, and team run. The bridge must remain stdio-only and must not introduce an
HTTP server, daemon, queue, or database.

## 5. Config/schema inventory

The reference schema has five main areas:

- `hermes`: command, profile flag, default cwd, timeout, and default toolsets;
- `discovery`: enabled flag, profile prefix, and stopped-profile behavior;
- `routing`: default profiles and panel size;
- `safety`: default side-effect policy;
- `kanban`: optional board, dispatcher, workspace, creator, and max runtime;
- `agents`: profile metadata and capabilities.

The YAML example is public-safe and shows an explicit local Hermes command,
default cwd, routing defaults, advice-only policy, and three specialist
profiles. Codex and Claude configuration examples both launch one local MCP
command and pass the YAML path through an environment variable.

For v2, retain the reference's YAML/JSON + Zod approach but make these concepts
first-class: `teams`, `workers`, `models`, `providers`, runtime kind, distro,
toolsets, allowed paths, worktree policy, concurrency, and timeout. Provider
credentials remain environment/profile-owned and never enter the config result.

## 6. Hermes CLI invocation path

The reference path is:

```text
MCP tool -> HermesCliProvider -> spawn(command, argv, cwd/env)
        -> hermes --version / profile list / --profile <name> --oneshot <prompt>
```

The reference passes arguments as an array, which is the correct foundation for
avoiding shell interpolation. Its missing pieces for v2 are programmatic prompt
transport, explicit model/provider/toolset/cwd selection, direct-vs-WSL runtime
selection, timeout/termination evidence, and structured invocation diagnostics.

The local Hermes 0.13.0 installation inspected for this project exposes
top-level `-z/--oneshot` and `hermes chat -q/--query`; its help did not expose
the PRD's preferred `--query-file` flag. The adapter must therefore probe the
actual installed CLI and use a safe stdin/temporary-file-compatible fallback,
with tests for the detected command shape. It must not silently revert to a
hard-coded profile alias.

## 7. Team/agent registry behavior

The reference has one effective profile registry: configured entries merge over
discovered Hermes profiles, disabled entries delete profiles, and the output is
sorted for deterministic results. Metadata is public-facing and includes role,
description, capabilities, cwd, toolsets, and source metadata.

v2 adapts this into separate registries:

```text
Provider Registry -> Model Registry -> Worker Registry -> Team Registry
                                      \-> capability resolver
```

Resolution precedence is explicit request, worker override, team default, then
validated registry default. A missing provider/model/profile must fail with a
structured error; it must not silently choose an unrelated provider or model.

## 8. Router behavior

The reference router is deterministic and multilingual, but it performs
keyword/stem matching over free-form task text. It is useful as an explainable
fallback experiment, not as the v2 execution authority. The PRD explicitly
places decomposition and role selection with Sol/Codex. v2 routing will use
explicit team/worker IDs and capability filters, returning why, candidates,
selected route, and any unresolved capability without pretending to infer
semantic intent inside the bridge.

## 9. Side-effect policy behavior

The reference supports `advice_only`, `read_only`, `local_files_allowed`,
`external_side_effects_need_approval`, and
`external_side_effects_allowed`. It inserts a natural-language policy into
specialist prompts and durable task bodies. It correctly documents that this is
not a sandbox.

v2 retains the enum and prompt guardrail, then adds execution-level constraints:
workspace/cwd checks, allowed-path evidence, write isolation, and explicit
warnings when a worker's actual diff exceeds its declared scope. The bridge
reports violations; Sol/Codex makes the semantic acceptance decision.

## 10. Panel behavior

The reference panel routes or accepts profiles, runs independent one-shot calls
with `Promise.all`, and extracts Recommendation/Evidence/Risks/Disagreement/
Next Actions headings into deterministic buckets. It does not perform a model
consensus call.

v2 keeps panel calls optional and bounded. Each opinion receives the same task
contract but an isolated run identity. The bridge returns all structured results
and evidence; it does not collapse disagreement into a single conclusion.

## 11. Kanban behavior

The reference treats Kanban as an optional durable mode and wraps Hermes
`kanban create/show/runs --json` commands. Creation is disabled by default and
the policy is prepended to the body. Result collection is tolerant of several
raw task/run field names.

v2 does not make Kanban part of P0. The no-daemon/no-database local execution
bridge first implements bounded Worker/Team runs. If Kanban is enabled later,
its tools must be conditionally registered and must not alter the P0 execution
contract.

## 12. Doctor/init-config behavior

`init-config` writes a starter YAML file with restrictive permissions when the
destination does not exist. `doctor` loads config, checks `hermes --version`,
discovers profiles, and prints JSON with config path, runtime health, active
profiles, safety, and Kanban settings.

v2 retains the user experience and doctor reports the Node version, configured
direct/WSL runtime, distro, Hermes version, discovered profiles, registry
counts, and that the probe was not run. Health must be safe to run without
invoking a model.

## 13. Test coverage map

| Reference test | Covered behavior | Missing coverage relevant to v2 |
|---|---|---|
| `config.test.ts` | Zod default side-effect policy | provider/model/team/worker defaults, path and secret validation |
| `hermes-cli.test.ts` | Profile table parsing with glyphs and columns | spawn argv, stdin/query transport, timeout, direct/WSL adapters, structured errors |
| `router.test.ts` | specialist matching, defaults, Russian aliases | explicit capability resolution, ambiguity, no keyword NLP dependency |
| `structured.test.ts` | role JSON normalization, panel buckets, Kanban result | Task Contract/result schema, git evidence, allowed paths, failure and timeout states |

The reference's CI runs install, test, typecheck, build, and formatting checks.
The v2 test matrix must add fake Hermes executables, fake direct/WSL adapters,
worker failures, no-run checks, parallel isolation, and real configured-model
smoke coverage without putting credentials in the repository.

## 14. Open PR/Issue risks

The open upstream items were checked on 2026-08-26:

| Item | Problem | Relevant to us | Decision |
|---|---|---|---|
| [PR #4](https://github.com/AlekseiUL/codex-plus-hermes-team/pull/4) | One-shot without explicit model/provider can fall through to an unintended gateway and fail with a 401/credits error; the PR also contains provider-specific/session-resume changes. | Yes: registry-selected model/provider must be passed explicitly. | Adapt explicit provider/model pinning only. Reject hard-coded provider workarounds and automatic `state.db` session discovery/resume. |
| [PR #3](https://github.com/AlekseiUL/codex-plus-hermes-team/pull/3) | Documents that Hermes may not be on Windows PATH and recommends an absolute command path. | Yes: Windows doctor and runtime resolution need truthful diagnostics. | Adapt absolute command support and PATH diagnostics; keep runtime configuration provider-neutral. |
| [Issue #2](https://github.com/AlekseiUL/codex-plus-hermes-team/issues/2) | Windows README/PATH friction for the Hermes command. | Yes. | Add direct/WSL command discovery, explicit command configuration, and actionable doctor output. |
| [PR #1](https://github.com/AlekseiUL/codex-plus-hermes-team/pull/1) | Memory OS prompt guardrail to prevent unsupported durable-memory claims. | Partly: execution prompts need bounded context and evidence. | Reuse the principle as a prompt constraint, but do not make memory persistence part of P0. |

The important upstream lesson is explicit model/provider pinning. The bridge
will not copy the PR's `NO_PROXY`, provider-specific hacks, direct SQLite
inspection, or automatic `--resume` behavior because those violate the v2
provider-neutral and deterministic execution contract.

## 15. Windows/WSL gaps

The reference assumes a command named `hermes`, a POSIX-like cwd in examples,
and one local process adapter. It does not define Windows path conversion,
WSL distro selection, command lookup, stdin handling, process-tree cleanup,
worktree isolation, or Windows-specific doctor checks.

The target environment is Windows with WSL distro `Ubuntu-24.04` and Hermes
0.13.0. The bridge must support both direct and WSL runtime kinds, convert cwd
and task paths explicitly, preserve UTF-8, avoid shell interpolation, and
surface nonzero exit, timeout, and startup diagnostics separately. The distro
and all model/provider values are configuration inputs, not execution-code
constants.

## 16. Reference vs codex-hermes-bridge gap analysis

| Current target asset | Reference concept | Keep | Change |
|---|---|---|---|
| `.codex-plugin/plugin.json` | MCP/client integration metadata | Yes | Update description/entry points for execution bridge while preserving installability |
| `skills/hermes-review/` | Reference Hermes skill | Yes | Keep review compatibility and add a concise execution skill |
| PowerShell execution shim | Hermes command provider | Yes | Make it a thin compatibility launcher for the TypeScript MCP/CLI path; remove Ox/profile hardcoding from core |
| Review presets/config | Registry/config patterns | Yes | Keep immutable review pipeline; do not route execution through reviewer presets |
| Review concurrency | Parallel tool execution | Yes | Reuse bounded-concurrency discipline, but use worktrees for concurrent writers |
| Immutable material bundle/evidence | Structured results | Yes | Adapt deterministic evidence accounting to worker runs |
| WSL execution | Local Hermes process | Yes | Replace shell-generated prompt with an argument/stdin-safe adapter |
| Hard-coded Ox path/profile in legacy exec script | Model/provider selection | No | Move values to example config and resolver inputs; no `hermes-ox` core dependency |
| No-run PowerShell smoke | Reference unit/build tests | Yes | Retain as legacy regression test and add TypeScript unit tests |

The target currently has no TypeScript package or MCP server. It is a plugin
containing a PowerShell review pipeline and a user-added Ox execution script.
The refactor therefore adds the smallest TypeScript MCP core alongside, rather
than deleting, the proven review asset.

## 17. Reuse/adapt/reimplement/reject matrix

| Reference module/asset | Decision | Reason |
|---|---|---|
| `src/config.ts` | ADAPT-CODE | YAML/JSON + environment precedence is proven; extend schemas and path checks |
| `src/command.ts` | ADAPT-CODE | Spawn/capture/timeout base is useful; add stdin, timeout state, and safe process handling |
| `src/types.ts` | ADAPT-CODE | Zod contracts are valuable; replace advice-only agent types with Task/Run/registry schemas |
| `src/index.ts` | ADAPT-CODE | stdio MCP and `doctor`/`init-config` shape is useful; register v2 tools and keep legacy review separate |
| `src/registry.ts` | ADAPT-CODE | deterministic precedence is reusable; split provider/model/worker/team registries |
| `src/providers/hermes-cli.ts` | ADAPT-CODE | command-provider boundary is strong; implement direct/WSL execution contract and explicit pins |
| `src/policy.ts` | REUSE-CONCEPT | keep honest policy language; implement workspace/path enforcement in v2 evidence layer |
| `src/router.ts` | REIMPLEMENT | Sol/Codex owns natural-language planning; use explicit IDs and capability filters |
| `src/structured.ts` | REUSE-CONCEPT | keep typed result/evidence discipline; remove semantic synthesis from bridge core |
| `tests/*` | ADAPT-CODE | preserve deterministic fixture style; add fake runtimes, schema, isolation, and MCP tests |
| `skills/hermes-team/SKILL.md` | REIMPLEMENT | target user workflow is Codex-managed execution, not advice-first consultation |
| `examples/team.yaml` | ADAPT-CODE | preserve a generic, secret-free example using the currently configured non-Ox route |
| Reference Kanban integration | REJECT for P0 | optional durable mode is not needed for the local execution MVP |
| Reference PR #4 session resume/SQLite changes | REJECT | non-deterministic and provider-specific; violates PRD guardrails |
| Current review bundle/pipeline | REUSE-CONCEPT / COMPATIBILITY | user explicitly needs it preserved; do not route new execution through it |

Architecture inspired in part by
`AlekseiUL/codex-plus-hermes-team`. The v2 implementation will be an
independent implementation of the execution contract; no substantial source
file is copied into the target. The reference MIT license is reviewed and no
additional derived-code notice is required for the planned reuse level.

## 18. Proposed implementation order

The work follows the PRD phases and stops for verification at each boundary:

1. Phase -1: this intake document, baseline, upstream signals, and matrix.
2. Phase 0: freeze the existing review smoke and record the target baseline.
3. Phase 1: add a minimal TypeScript package, stdio MCP skeleton, health, and
   doctor without invoking a model.
4. Phase 2: add Zod config, Provider/Model/Worker/Team registries and explicit
   resolver tests, including the model/provider pin rule.
5. Phase 3: add direct and WSL Hermes runtime adapters with safe prompt
   transport and fake-runtime tests.
6. Phase 4: implement one `hermes_worker_run` with Task Contract, prompt
   template, deterministic git evidence, allowed-path warnings, and structured
   result schema.
7. Phase 5: run real configured-model smoke tests only with user-configured
   credentials; do not store or print keys. The retired paid route is not used
   for future runs.
8. Phase 6: update Skill/plugin integration and preserve the legacy review
   smoke.
9. Phase 7: add bounded parallel independent tasks with worktree isolation and
   no auto-merge.
10. Phase 8: add optional panel behavior; defer Kanban until the P0/P1 core is
    stable.
11. Phase 9: conditionally register optional Kanban tools if implemented.
12. Phase 10: remove obsolete hard-coded execution paths, update docs, run
    full tests/typecheck/build/smoke, and package the source.

No implementation phase may silently bypass a failed contract test. The bridge
reports evidence and failures; Codex/Sol remains responsible for semantic
review, acceptance, and final integration.
