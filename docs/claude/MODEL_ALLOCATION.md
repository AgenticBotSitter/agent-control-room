# Model and effort allocation

Date: 2026-09-11. Companion to `BUILD_PLAN.md`. Project-specific allocation based on task
shape, not a benchmark claim. Revalidate at each stage boundary; available models change.

## Principle

Match the model to the *failure mode*, not the file count.

- Work where a wrong answer is **caught by a test** → cheaper model, lower effort.
- Work where a wrong answer is **silently absorbed** — a security boundary, an authority
  rule, a schema migration, an isolation guard — → strongest model, high effort.
- Reading logs, triaging, summarising → cheapest model.

The repository already enforces implementer ≠ reviewer. Keep that. A reviewer must run in a
separate session that did not write the code, or it is not an independent review.

## Allocation by stage

| Stage | Work | Claude | Effort | Why |
|---|---|---|---|---|
| 0.1, 0.3 | Architecture-guard and handoff test failures | Opus 5 | high | Isolation boundaries and one-use key custody; a plausible-looking fix that weakens the guard is the exact failure this catches |
| 0.2 | Type-coverage failure | Sonnet 5 | medium | Mechanical; compiler verifies |
| 0.5 | Merge the 63-PR stack | Sonnet 5 | low | Repetitive; CI verifies |
| 0.6 | CI restoration | Sonnet 5 | medium | Config, verified by running |
| 1 | IP-01/IP-04, markdown, Readability, cron-parser | Sonnet 5 | medium | Decided, specified, test-covered |
| 1 | Independent review of IP-04 database lifecycle | Opus 5 | high | Uncertain-COMMIT and no-replay semantics are silently absorbable |
| 2 | Codex execution seam | Opus 5 | high | The critical path; subprocess custody, sandbox, cancellation, no duplicate starts |
| 2 | Independent review of Stage 2 | Opus 5 | high | Separate session; this is the gate the whole build rests on |
| 3 | Kuma / pgBackRest / supervision config | Sonnet 5 | medium | Configuration of maintained tools |
| 3 | Restore rehearsal verification | Opus 5 | high | "Prove restore" is the acceptance; a false pass here is unrecoverable |
| 4 | Claude Code CLI seam | Sonnet 5 | high | Shape is known from Stage 2; raise effort, not model |
| 4 | Hermes upstream integration | Opus 5 | high | Upstream API surface, no fork, credential separation |
| 5 | Continuous pickup, concurrency, drain | Opus 5 | high | Distributed-state correctness; duplicate execution is silently absorbed |
| 6 | Wayfarer FFmpeg executor, ABS, Idea Lab | Sonnet 5 | medium | Rides a proven path; failures are visible |
| 6 | UI work from hermes-desktop / hermes-webui donors | Sonnet 5 | medium | Visual, iterative, cheap to correct |
| 7 | Public classification and export | Opus 5 | high | Default-deny classification; a leak is irreversible |
| 7 | Notices, licences, packaging | Sonnet 5 | medium | Tool-driven (DR-03/04) |
| any | Log triage, test-failure summarising, status | Haiku 4.5 | low | Read-and-report |

## Codex allocation

Keep the existing convention in `BUILD_STATUS.md`: Astra Medium for root integration, Astra
High for independent boundary review. That allocation is sound; nothing here changes it.
Codex is the better choice for Stage 2 work performed *through* its own CLI seam only if you
want the adapter exercised by its own runtime — otherwise either assistant is fine.

## Efficiency rules

1. **Never run the strongest model on mechanical work.** Stage 0.5 and most of Stage 1 are
   Sonnet work. Using Opus there is where budget disappears with nothing to show.
2. **Raise effort before raising model.** Stage 4's Claude Code seam is Sonnet/high, not
   Opus/medium — the design is already settled by Stage 2.
3. **One block at a time, with a named exit.** The repository's existing update rule is
   correct and should be kept: exactly one active block, its exit condition stated.
4. **Batch commits; do not trigger CI per edit.** But never `[skip ci]` a code change again.
5. **Do not spend a strong model writing documentation.** This repository has 116k lines of
   docs against 125k lines of code. That ratio is the single largest sink of effort here.
   Prefer tests as evidence over prose as evidence.
