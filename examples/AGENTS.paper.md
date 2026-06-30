# Codex Paper Workflow With Hermes

Use Chinese for project communication unless the manuscript or target journal requires English. Preserve scientific meaning, citation keys, numerical results, equations, table values, and terminology.

## Hermes Independent Review

1. Use Hermes-first for simple checks: citation counts, formatting scans, spelling scans, obvious consistency checks, file lists, and narrow reference audits. Prefer Hermes flash with path-only input so Codex does not need to read large files first.
2. Hermes-first default command:
   `powershell -NoProfile -ExecutionPolicy Bypass -File "<codex-hermes-bridge>\tools\hermes-review.ps1" -Flow delegate -Lite -Mode flash -PathOnly -MaxFindings 8 -ProjectRoot "<project-root>" -TaskType paper -Path "<file>" -ExtraPrompt "<specific check>"`
3. Use Codex-led work followed by Hermes review for manuscript logic, claim strength, evidence boundaries, result interpretation, figure/table consistency, citation/evidence fit, and final submission checks.
4. Run deterministic local checks first when available, such as LaTeX compilation, file existence checks, citation key scans, or user-requested scripts.
5. After a meaningful manuscript edit, call Hermes before the final response. Small edits may be batched into one review.
6. In non-git projects, pass the changed `.tex`, `.bib`, `.md`, `.txt`, or review-record files explicitly with `-Path`.
7. Default post-change review command:
   `powershell -NoProfile -ExecutionPolicy Bypass -File "<codex-hermes-bridge>\tools\hermes-review.ps1" -ProjectRoot "<project-root>" -TaskType paper -Path "<changed-file>"`
8. Use `deepseek-v4-flash` for ordinary language, format, and narrow citation checks. Use `deepseek-v4-pro` for paper logic, experimental claims, result interpretation, figure/table consistency, final checks, or multi-file changes.
9. Do not persist Markdown reports unless the user asks. Relay Hermes findings in the final response and let the wrapper delete its temporary report.
10. Treat Hermes as independent input, not automatic truth. Codex must verify findings before changing files or accepting conclusions.
