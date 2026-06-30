# Codex Coding Workflow With Hermes

Use Chinese for project communication unless code comments, APIs, logs, or documentation require English. Keep changes small, local, and consistent with the existing project.

## Development Flow

1. Identify the current subproject root before editing.
2. Read relevant README, config, entry points, and existing style before changing code.
3. Run available validation after changes: tests, lint, type checks, build, or a minimal startup check.
4. Do not rewrite unrelated files or overwrite user changes.

## Hermes Independent Review

1. Use Hermes-first for simple checks: file lists, config summaries, error summaries, formatting scans, obvious consistency checks, and narrow grep-like audits.
2. Hermes-first default command:
   `powershell -NoProfile -ExecutionPolicy Bypass -File "<codex-hermes-bridge>\tools\hermes-review.ps1" -Flow delegate -Lite -Mode flash -PathOnly -MaxFindings 8 -ProjectRoot "<project-root>" -TaskType code -Path "<file>" -ExtraPrompt "<specific check>"`
3. Use Codex-led work followed by Hermes review for implementation, architecture, API/database/auth/dependency changes, test failure fixes, complex debugging, and final handoff review.
4. Prefer reviewing git diff when available. If there is no git diff or the project is not a git repository, pass changed files explicitly with `-Path`.
5. Default post-change review command:
   `powershell -NoProfile -ExecutionPolicy Bypass -File "<codex-hermes-bridge>\tools\hermes-review.ps1" -ProjectRoot "<project-root>" -TaskType code`
6. Non-git or no-diff review command:
   `powershell -NoProfile -ExecutionPolicy Bypass -File "<codex-hermes-bridge>\tools\hermes-review.ps1" -ProjectRoot "<project-root>" -TaskType code -Path "<changed-file>"`
7. Use `deepseek-v4-flash` for small single-file or obvious checks. Use `deepseek-v4-pro` for multi-file changes, architecture/API/database/auth/dependency changes, test failure fixes, and final delivery review.
8. Do not persist Markdown reports unless the user asks. Relay Hermes findings in the final response and let the wrapper delete its temporary report.
9. Treat Hermes as independent input, not automatic truth. Codex must verify findings before changing files or accepting conclusions.
