# Changelog

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
