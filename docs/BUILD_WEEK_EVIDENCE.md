# OpenAI Build Week 2026 evidence

This document separates the pre-existing LoopCodeLab project from the meaningful extension built
during the OpenAI Build Week Submission Period. It intentionally excludes private source history,
credentials, tenant data, and raw Codex transcripts.

## Existing project disclosure

LoopCodeLab existed before the Submission Period. Its public snapshot was published before the
event work described below. Judges should evaluate the Build Week extension through the hosted demo,
this evidence record, the primary Codex Session ID, and the narrated demo video.

The private production development tree recorded its final pre-cutoff checkpoint at:

- Commit: `119920277a48c496ef51d8aa304eea5bdb11aca8`
- Timestamp: `2026-07-13T13:12:30Z`
- Submission cutoff used for comparison: `2026-07-13T16:00:00Z`

## Codex and GPT-5.6 evidence

| Field | Recorded value |
|---|---|
| Primary Codex Session ID | `019f7a93-725e-7c00-a3a5-e7f5b4cbbef4` |
| Surface | Codex CLI interactive TUI |
| Model | `gpt-5.6-sol` |
| Working directory | Private production development tree for LoopCodeLab |
| Session start | `2026-07-19T13:31:51Z` |
| Session end | `2026-07-19T23:02:00Z` |
| Output | 22 scoped commits created and pushed |
| Additional workers | In-period `codex exec` sessions using GPT-5.6 Sol and Terra |

The Session ID is supplied in the Devpost submission so OpenAI can verify the primary thread. The
demo should briefly show `/status`, the selected GPT-5.6 model, and representative implementation
and verification moments without exposing secrets.

## Representative in-period checkpoints

These immutable commit identifiers and timestamps come from the private production development
history. Subjects are included so the work can be correlated with the Codex thread and demo.

| Commit | UTC timestamp | Subject |
|---|---|---|
| `4ba3f12` | `2026-07-19T16:12:59Z` | `feat: add plan based shared builds and teams` |
| `cf73cd7` | `2026-07-19T16:37:52Z` | `feat: add admin shared model route picker` |
| `98a94a0` | `2026-07-19T18:32:14Z` | `feat: add tiered admin model exposure` |
| `ce1b11c` | `2026-07-19T18:55:29Z` | `feat: expose Claude subscription through shared broker` |
| `0257666` | `2026-07-19T21:04:20Z` | `feat(models): broker subscription and token-plan routes` |
| `46c0770` | `2026-07-19T21:33:10Z` | `feat(admin): expose Qwen and Grok media models` |
| `45b1ae5` | `2026-07-19T22:36:57Z` | `feat(admin): expose current BytePlus models` |
| `7374d8a` | `2026-07-19T23:01:29Z` | `docs: record shared model routing invariants` |

The private development tree contains 254 commits after the official cutoff. The table highlights
the cohesive feature sequence produced in the primary GPT-5.6 Codex thread rather than claiming
that every in-period commit belongs to that one thread.

## Product and engineering decisions

- **Frozen routing:** capture master, worker, and fallback routes at build start for reproducibility.
- **Fallback before blocking:** try compatible routes in administrator-defined order.
- **Honest admission:** expose only connected models whose adapters support the requested role and
  protocol.
- **Fair quota:** do not consume an Included-build allowance when no route can start; keep BYO-key
  usage separate.
- **Tenant safety:** preserve per-tenant credentials and capability boundaries while using the
  administrator-funded pool.

## Verification performed in the primary thread

- Focused Node tests for build access, model exposure, broker behavior, route ordering, provider
  adapters, and UI state helpers.
- Repeated `npm run check`, `npm test`, and `npm run verify` executions.
- Production frontend and documentation builds.
- `git diff --check` before scoped commits.
- Service restarts followed by local and deployed `/healthz` checks.
- Real-product iteration on missing lead-capable routes, provider path/protocol mismatches, OAuth
  models missing from the exposure catalog, and role-incompatible model choices.

## Human contribution

Muhammad Tayyab Ilyas defined the product goals and constraints, answered the requirements questions,
selected the routing and quota policies, reviewed the resulting behavior, operated the deployment,
and retained final acceptance authority. Codex accelerated architecture tracing, implementation,
testing, debugging, review, and Git integration.
