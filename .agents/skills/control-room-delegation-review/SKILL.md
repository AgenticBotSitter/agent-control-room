---
name: control-room-delegation-review
description: Create bounded GitHub work packets for external agents and review their pull requests before integration. Use for Control Room or similar multi-agent build workflows; do not use for ordinary single-agent coding.
---

# Control Room delegation review

GitHub is the temporary coordination plane until Control Room can schedule itself. Codex owns contracts, security boundaries, acceptance criteria, integration, and every merge. Workers contribute bounded evidence or isolated implementation capacity.

## Dispatch

- Choose a proportional mode: `standard-work` for isolated repository work, `platform-validation` for otherwise unavailable host evidence, `controlled-effect` for credentials, permissions, persistence, destructive cleanup, or other high-risk effects, and `independent-review` only when independence materially reduces risk.
- State the block, worker route, objective, exact immutable base, one bootstrap fetch when needed, branch, allowed paths, immutable inputs, acceptance commands, environment/effect boundary, repair budget, stop conditions, and handoff.
- Make missing prerequisites explicit. Installs, downloads, persistent changes, restarts, live integrations, and network fallback require named authority.
- Keep setup separate from readiness and native execution. Readiness cannot consume a native attempt. Workers never author or repair the qualification harness during a platform run.
- Use the machine-validated effect contract only for genuinely controlled effects; applying it to ordinary work is a coordination defect.
- Do not delegate protocol design, authorization rules, secret handling, migrations, effect execution, or final security decisions.

Prefer one focused repair for ordinary report/code work. For platform validation, allow report-only correction after the native attempt; never imply permission to rerun the effect. Every exact disposable target has exact cleanup and an absence check. Workers never self-review, self-approve, or self-merge.

## Review

1. Compare changed paths with the issue before reading content.
2. Reconstruct setup, readiness, native attempts, corrections, and cleanup from issue comments, PR metadata, commits, and the current head.
3. Separate observed, owner-observed, documented, inferred, blocked, and unsupported claims.
4. Check citations, exact exit codes, effect counts, scope, cleanup, redaction, contradictions, and whether the disposition matches the central gate.
5. Request one bounded report-only correction when the evidence is useful but the report is inaccurate. Do not rewrite the worker patch unless the user explicitly authorizes that.
6. Merge only accepted evidence in dependency order, record a concise disposition, close the issue, synchronize `main`, and run the smallest relevant deterministic checks.

Documentation may be merged as negative or research evidence without adopting its proposals. Preserve failed attempts and corrections; a later success does not erase them.

## Safety

Never request or publish secrets, personal tokens, production artifacts, personal paths, raw host identity, or raw native diagnostics. Use least-privilege GitHub access. Exact cleanup must not expand after a failure; stop and request owner direction.
