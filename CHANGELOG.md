# Changelog

## Unreleased

- Switched the configured `quick` route to DeepSeek V4.1 Flash and aligned the public Skill/default prompt with the live registry.
- Hardened command execution with bounded output, stream-error propagation, cancellation, timeout handling, and profile-aware usage export.
- Hardened Git evidence for staged/index-only edits, rename source paths, symlinks, Unicode paths, and bounded file hashing.
- Added deterministic fail-fast/cancellation boundaries, realpath workspace-root checks, single-worker worktree execution, and structured failure results.
- Added JSON secret redaction coverage and rejected configuration flags whose behavior is not implemented.

## 0.4.0

- Configured Qwen3.8-Flash through Alibaba Model Studio as the deterministic default (`routing.defaultWorker: quick`); DeepSeek-V4-Flash remains an explicit-only route through the official DeepSeek API.
- Hardened team input validation and Git evidence so missing task IDs and committed out-of-scope files are reported before acceptance.
- Added the TypeScript stdio MCP execution core for Codex-managed Hermes Worker and Team tasks.
- Added YAML/Zod Team, Worker, Model, Provider registries with deterministic routing and no silent paid fallback.
- Added direct and configurable WSL runtimes, Hermes profile discovery, health/doctor, timeout handling, and automatic `--query` / `--query-file -` compatibility.
- Added Task Contracts, deterministic Git evidence, allowed-path checks, structured worker results, bounded parallel execution, and isolated worktrees without auto-merge.
- Added the `hermes-team` execution Skill while preserving the existing `hermes-review` pipeline as an explicit compatibility feature.
- Added disposable real-runtime smoke coverage for configured Qwen and DeepSeek routes without storing credentials.

## 0.3.0

- Replaced overlapping routing parameters with five presets: delegate, paper, paper-deep, code, and code-deep.
- Set the standard paper panel to DeepSeek Pro, DeepSeek Flash, and Qwen Plus.
- Made the Skill directory the only implementation source; the top-level wrapper is now a three-line shim.
- Replaced tracked-only hybrid review with one immutable bundle covering staged, unstaged, deleted, and untracked material.
- Reduced output to one strict JSON result and moved semantic synthesis to Codex/Sol after independent reviews finish.
- Consolidated model/profile configuration, removed generated copies, JSONL, migration docs, duplicate manuals, and wrapper-side consensus logic.
- Added high-confidence content scanning and truthful complete/incomplete/read-failed coverage.
- Added explicit run states, strict reviewer/output validation, paper concurrency defaults, reviewer progress reporting, and minimal-change guardrails.

## 0.2.0

- Added configuration-driven model and review profiles.
- Added `paper-independent`: every selected model receives one full material snapshot and submits an isolated whole-package review.
- Set the standard three-model paper panel to DeepSeek Pro, DeepSeek Flash, and Qwen Plus.
- Added `code-global` and `code-hybrid` profiles. Formal code-review assignments now use strong models; flash models remain bounded delegates.
- Added reviewer-level prompts, bounded parallel execution, per-reviewer status/output files, timeouts, and limited retry behavior that avoids typical authentication/configuration retries.
- Fixed WSL preflight quoting so Linux expands `$HOME`/`$PATH`, and write Hermes prompt/input files as UTF-8 without BOM.
- Added material snapshot IDs, coverage metadata, external-image opt-in, sensitive-input guardrails, and outside-project opt-in.
- Added Markdown, JSON, and JSONL report modes with reviewer state and conservative deterministic aggregation.
- Added a self-contained Codex plugin manifest and a build script that synchronizes the repo wrapper with the bundled Skill distribution.
- Expanded no-token smoke coverage for compatibility, isolation, profile routing, report formats, and runner behavior.

## 0.1.0

- Initial local PowerShell → WSL → Hermes review bridge with a Codex Skill, templates, vision sidecar, and no-run smoke test.
