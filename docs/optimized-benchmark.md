# Optimized execution benchmark

This controlled benchmark used the same starter repository and event-sourced
Python job queue contract before and after the execution-policy optimization.
Both bridge runs used Alibaba `qwen3.8-flash`; hidden tests were not included in
worker prompts.

| Metric | Previous team run | Optimized single worker | Change |
|---|---:|---:|---:|
| Quality | 20/20 | 20/20 | unchanged |
| Hermes sessions | 4 | 1 | -75.0% |
| API calls | 74 | 15 | -79.7% |
| Input tokens | 1,116,510 | 201,298 | -82.0% |
| Cache-read tokens | 1,433,470 | 266,051 | -81.4% |
| Output tokens | 77,950 | 20,849 | -73.3% |
| Comparable total tokens | 2,627,930 | 488,198 | -81.4% |
| Wall time | 606.1 s | 314.272 s | -48.1% |

The optimized run used 2,139,732 fewer Qwen tokens, about 5.38 times less,
while preserving all 8 public and 12 hidden test passes. The improvement came
primarily from defaulting to one bounded worker instead of duplicating context
across three workers and an integrator.

An earlier pure Codex Luna Max run used 735,578 comparable model tokens and
scored 19/20. The optimized Qwen worker used 488,198 model tokens and scored
20/20. This is not a complete system-total comparison because the coordinating
Codex conversation's token usage is not exposed by the bridge.

The benchmark supports a narrow policy conclusion: use one worker by default,
and reserve parallel teams for genuinely independent, long-running scopes where
latency or specialist quality justifies duplicated context.
