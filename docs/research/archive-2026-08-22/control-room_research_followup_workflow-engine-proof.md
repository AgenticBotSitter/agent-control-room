# Durable Workflow Engine Proof — Gate 3 (Hatchet vs DBOS vs PG/SQLite-Native Build)

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Gate evidence for:** Gate 3 in `docs/RESEARCH_SYNTHESIS_AND_BUILD_DECISIONS.md`

---

## Execution-environment honesty statement (read first)

The dispatch assumed Docker or Postgres locally. **Verified this session: neither exists on this Mac** (`docker` not found; no colima/podman/orbstack; no psql/initdb under /opt/homebrew or /usr/local). Installing Docker Desktop = licensing + resource decision beyond $0 scope; installing Postgres via brew = new standing service. Per the brief's own fallback clause, the hands-on proof was executed **as plain processes against a SQLite-native state-machine implementation of the same architecture family as Hermes kanban (WAL + BEGIN IMMEDIATE)** — which is also the "minimal queue/state-machine" finalist. Hatchet and DBOS proofs therefore remain **docs-based [UNTESTED-here]** with exact local prerequisites documented so they can run on Johnny5 (which has Docker) later.

## What was actually tested (hands-on)

**Implementation under test:** `wf.py` (~150 lines, Python 3.11 venv): SQLite jobs/steps/outcomes/events tables, WAL mode, `BEGIN IMMEDIATE` claims, idempotency-keyed outcome table, 2.0s lease reclaim, file-flag approval gate, append-only effects log as the side-effect ledger.
**Full transcript of runs preserved in session; sanitized commands below.**

### Proof matrix results

| # | Proof dimension | Result | Evidence |
|---|---|---|---|
| 1 | Start 3-step workflow | ✅ PASS | `init` → job1 running, steps s1/s2/s3 pending |
| 2 | Pause for external approval | ✅ PASS | worker exits cleanly at gate after s2; job=waiting_approval; resumes on flag+approve |
| 3a | Kill worker mid-run (SIGKILL during step) | ✅ PASS | process died with no cleanup; step left 'running', outcomes unchanged |
| 3b | Kill server | n/a — no separate server by design (embedded); noted as structural difference vs Hatchet |
| 4 | Restart recovery | ⚠️→✅ PASS **after fix** | First restart SKIPPED the killed step ('running' was invisible to claim query) — real bug found; added lease-expiry reclaim (`started_at < now-LEASE`). Second run: killed step reclaimed and completed |
| 5 | Exactly-once EFFECT | ✅ PASS | Two concurrent workers racing all steps: effects log shows exactly {fetch:1, transform:1}; loser's event records effect_performed:false; duplicates:{} |
| 6 | Cancel cleanly | ✅ PASS | cancel mid-flight → job=cancelled at next loop check; no further effects; partial work persisted correctly |
| 7 | Retry failed step | ✅ PASS | armed first-attempt failure on s3: attempt1 failed (event logged), attempt2 succeeded; attempts counter visible in schema |
| 8 | History inspection | ✅ PASS | append-only events table: workflow_started→step_start(n)→step_failed→step_done(effect_performed bool)→awaiting_approval→approved→cancelled, full ordering queryable |
| 9 | Footprint | ✅ MEASURED | 40KB SQLite db (+shm/wal), one Python process, zero daemons; components: sqlite3 stdlib only |

### The two bugs the proof caught (why proofs matter)

1. **Skipped-step-on-recovery:** SIGKILL left a step 'running'; naive claim queries ignore 'running'. Fix = lease column + time-based reclaim. This is exactly why Hermes kanban has `claim_expires`.
2. **Effect-before-claim race:** original code wrote the side effect then claimed the outcome — two workers could both act. Fix = claim (outcome insert, BEGIN IMMEDIATE) FIRST, act second. Consequence (T7, hardest case): death between claim and act yields **at-most-once for that one effect** — the classic exactly-once-is-a-lie tradeoff, now demonstrated concretely rather than hand-waved.

### T7 detail (claim-then-die)
Simulated death after outcome-commit but before side-effect write: recovery skips the step forever (outcome exists), missing effect line never re-executed. Mitigations if we build: intents table + reconciliation sweep, or make effects themselves idempotent-by-key. Documented as residual risk, not hidden.

## Docs-based verification (Hatchet / DBOS) [UNTESTED-here]

| Dimension | Hatchet | DBOS |
|---|---|---|
| License (server / SDK) | MIT / MIT (prior dossier, repo-verified 2026-08-22) | MIT / MIT |
| Local prereq NOT met on Mac | Postgres + server binary (Docker compose path exists) | Postgres only |
| Durability model | Postgres-backed queue + history | Checkpointed functions in Postgres |
| Exactly-once story | Queue redelivery + user-level idempotency keys required (docs) | Transactional checkpoints; app-level effects still need keys (docs) |
| Approval pause | sleep/event patterns | sleep/event pattern |
| Footprint @VPS | Postgres + hatchet-server container(s) | Your app + Postgres |

**To complete their hands-on legs on Johnny5 (has Docker):** `docker compose up` per official quickstart → rerun the identical 9-point script. Estimated effort: 1–2h. Not done here because VPS deployment is outside this Mac's disposable-test boundary and touches shared infra.

## Licenses verified this session
- No new LICENSE fetches needed: Hatchet MIT + DBOS MIT confirmed earlier today via GitHub API/LICENSE file (see license-reuse-matrix rows).

## Decision (single, per gate requirement)

**BUILD (minimal native state-machine), with DBOS as named fallback.**

Rationale: the proof demonstrates that every lifecycle property we need (lease-recovery, idempotent effects, approval gates, cancel/retry/history) is achievable in ~150 lines + SQLite with the SAME primitives Hermes kanban already trusts in production (WAL + BEGIN IMMEDIATE). That eliminates the Hatchet server+Postgres operational footprint entirely at current scale, keeps state inspectable in plain SQL, and avoids the two-engine problem (kanban boards vs workflow engine). Prior Hatchet hypothesis is OVERTURNED for v1 — not because Hatchet failed, but because the build alternative proved sufficient and cheaper to operate. Re-evaluate trigger: any need for multi-host workers, sub-second scheduling density, or UI dashboards over workflows → run the Johnny5 Hatchet proof leg and revisit.

## Unresolved risks & triggers
1. Single-node ceiling: SQLite build doesn't span machines — if CR jobs must run on both Marvin AND Johnny5 under ONE graph → trigger Hatchet/DBOS proof on VPS.
2. At-most-once window (T7 class) unacceptable for money-touching effects → add intents-table reconciliation before any payment integration.
3. Lease value (2.0s) tuned for test; production needs per-step lease budgets + renewal — spec before v1 build.

## Report-format compliance
Official sources: sqlite.org WAL docs semantics (stdlib behavior), prior-session GitHub API pulls for Hatchet/DBOS (cited in license matrix); versions pinned: python 3.11.15 (venv), sqlite3 stdlib of that venv; tested-vs-documented labeled throughout; commands sanitized (no secrets involved anywhere in harness); expected-vs-actual captured inline above; license/distribution effect: none (own code, MIT-compatible stack); A/W/B/B/D: BUILD w/ DBOS fallback + triggers.
