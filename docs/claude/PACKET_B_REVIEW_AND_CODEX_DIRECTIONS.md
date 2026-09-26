# Packet B review (Claude installed route) and directions for Codex

**From:** Claude (lead). **To:** Codex (builder and integrator). **Date:** September 24, 2026.
**Governing plan:** [`../CODEX_MAC_BUILD_EXECUTION.md`](../CODEX_MAC_BUILD_EXECUTION.md). This file does not change that plan. It records one review and tells Codex what to do with it.

## Part 1: Directions for Codex (do these first)

### 1. Stop working in two places

Two checkouts have diverged:

- **The old one:** `/private/tmp/acr-reconcile-local-release-343`, branch `codex/reconcile-local-release-343`.
  - It has 47 uncommitted changes.
  - It follows the older five-phase plan, `LOCAL_THREE_AGENT_PROGRESS.md`, which, for example, keeps Mac Codex "unavailable".
  - That plan is superseded.
  - `/private/tmp` can be wiped on reboot.
- **The correct one:** `~/work/acr-mac-local`, branch `claude/mac-local-integration`.
  - It has about 19 unpushed Codex commits (latest `b4dbe67a`).
  - They follow the correct plan.

Actions:

1. **Save the `/tmp` work without merging it.** In the `/tmp` checkout:
   - Create branch `codex/archive-five-phase-2026-09-24`.
   - Commit everything there, including the untracked files.
   - Push that branch.
   - Do **not** merge it into `claude/mac-local-integration`.
   - Later, you may reuse individual pieces from it, but only when a work package in the governing plan needs them.
2. **Push `claude/mac-local-integration`** so the owner and Claude can see your W1–W3 progress.
3. **From now on, work only in `~/work/acr-mac-local`** on the governing plan. Ignore `LOCAL_THREE_AGENT_PROGRESS.md`, `LOCAL_THREE_AGENT_EXECUTION_PLAN.md` and `LOCAL_AGENT_REVIEW_PACKETS.md`. In `LOCAL_MAC_CODEX_ROUTE_DECISION.md`, the ruling that Codex stays unavailable is overruled: **Codex is a managed Mac worker** (critical path decision 1).
4. **Record the switch.** Add an entry to `docs/MAC_LOCAL_PROGRESS.md` saying what was archived and why.

### 2. What the review means for the build

The review below covers the **old** Claude post-install admission route:

- `local-claude-post-install-admission.ts`
- the runtime assembly
- the operator status

The governing plan **replaces that route in `mac-local` mode**. Under W3 and W4, Claude runs through the owner-trusted enablement record and the generic local CLI worker port. Do **not** spend effort fixing findings 1, 2 and 4 in the old admission code; leave that code for the multi-machine phase.

These findings still apply to the new route and **must** be handled in W3 and W4:

- **Claude's command-line arguments (finding 3).** Do not use `CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1`.
  - It contains `--restricted`, `--permission-prompts none` and `--max-turns 1`. These were not listed in the installed CLI's help output.
  - It contains `--bare`, which may bypass the owner's subscription login.
  - It contains `--model opus`, which spends the owner's limited Opus usage.
  - Use the W4 arguments instead: `-p --output-format stream-json --verbose --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --disable-slash-commands`, with the prompt on stdin.
  - Leave the model at the CLI default, or use `sonnet` if a model must be pinned.
  - Before finalising, confirm every flag against the installed CLI's `--help` output (packet `MARVIN_H3_ADAPTER_FLAG_CROSSCHECK.md`).
- **Readiness must mean something (from finding 2).** In `mac-local` mode, a worker shows "ready" only when both are true:
  - its pinned executable exists and its `--version` output matches the enablement record, checked at startup
  - the worker has no failed readiness check since then

  Never show "ready" on the strength of a self-declared record. A worker counts as "proven" only after it has completed at least one real task through the website.
- **Result inspection must cover every worker (finding 5).** In `mac-local` mode, result inspection must include each enabled worker on its own. Claude must not depend on Hermes supplying the inspection source first.
- **Test gaps (finding 6).** The W4 and W7 tests must, for each worker:
  - run a revised (correction) task after `changes_requested`
  - cancel a running task

### 3. Reviews

Send your W3 and W4 diffs to Claude for review, as the governing plan says. Point to this file so the reviewer can check that findings 3, 5 and 6 were handled.

## Part 2: The Packet B review

**Scope:** read-only review of `/private/tmp/acr-reconcile-local-release-343`, including its uncommitted changes.

**Commands run:**

- `node --import tsx --test tests/hermes-claude-shared-lifecycle-conformance.test.ts tests/private-local-installation-runtime-assembly.test.ts`: 36 passed, 0 failed.
- `pnpm check` (tsc): passed, with no errors.

Claude was not started, protected configuration was not read, and no files were changed.

**Verdict:** partly passes.

- The lifecycle is shared.
- Readiness is not verified.
- The status and startup checks contradict each other.

### Answers to the packet's questions

1. **Same lifecycle? Yes.** `tests/hermes-claude-shared-lifecycle-conformance.test.ts:66` runs Hermes and Claude against one database. It proves:
   - two delivery receipts
   - two separate pending owner reviews
   - a Claude correction creating a revision plan, where replaying it returns the same receipt
   - restart recovery that starts neither worker a second time

   There is no separate queue or store.
2. **Readiness verified and tied to the same plan? No.** It is tied to *a* plan, but it is never checked against evidence, and the status check and startup check expect different plans (findings 1 and 2).
3. **Does status separate "ready to qualify" from "a live task completed"? Yes.** Status shows only `prepared` / `missing_local_proof`, and the activation proof state is `owner_attended_action`. No code path claims a live task completed. However, `prepared` rests on self-declared readiness (finding 2).

### Findings

1. **High: status and startup tie Claude readiness to different plans.**
   - Operator status requires readiness tied to the *installed* topology plan: `src/installer/v1/private-local-installation-operator.ts:297-298` and `src/installer/v1/three-worker-activation-bundle-preflight.ts:148`.
   - Startup admission requires the *transition* plan, which adds Claude to the Hermes-only plan: `src/installer/v1/local-claude-post-install-admission.ts:154` and `:189`.
   - The two plan digests always differ, so no single readiness record can both show "prepared" and admit Claude.
   - The tests hide this because they use different records: `tests/private-local-installation-runtime-assembly.test.ts:922/930` (original plan) versus `:1232-1250` (transition plan).
2. **High: Claude readiness is self-declared.**
   - `readinessDigest` is a hash of the record's own contents: `src/harness/claude-code-v1/local-process-readiness.ts:44-46` and `:49-54`.
   - Admission checks only that the state is `readiness_recorded`: `local-claude-post-install-admission.ts:188-189`.
   - The qualification report *is* bound to the process configuration (`:185-187`). But the `permission_boundary` and `cancellation_and_restart_recovery` proofs are not tied to any evidence: any digest counts as "passed".
   - `processObservation.observationDigest` is parsed but never recomputed (`:190-198`).
3. **Medium: the fixed Claude arguments probably don't match the installed CLI.** `src/harness/claude-code-v1/text-review-invocation-policy.ts:22-27`:
   - `--restricted`, `--permission-prompts none` and `--max-turns 1` were not listed in the installed CLI's help output (version 2.1.281), which Claude checked earlier this session.
   - `--bare` is minimal mode, and may bypass the owner's subscription login.
   - `--model opus` spends the owner's limited Opus usage.
   - The test fixture uses the same arguments (`tests/private-local-installation-runtime-assembly.test.ts:1244`), so tests cannot catch this.
4. **Medium: the second Claude check is not tied to the re-read journal.**
   - `src/installer/v1/private-local-installation-runtime-assembly.ts:259-261` re-checks Hermes against the re-read plan.
   - Claude, at `:262-269`, only compares its admission digest with itself. It uses caller-supplied history and transition readers (`:225-232`), not the assembly's journal.
   - Its receipt check at `:238-242` runs only against the first plan read.
5. **Low: Claude results may have no result inspection.** `private-local-installation-runtime-assembly.ts:247-248` extends inspection to Claude only when Hermes already supplied an inspection source.
6. **Low: test gaps.** The conformance test creates the Claude correction revision (around lines 290-297) but never runs it, and it never cancels a running Claude task.

**Does this support the next owner-attended qualification?** Only as source-only work. With findings 1 and 3 in place, qualification would either fail when the CLI parses its arguments, or produce a record that cannot pass both the status check and the admission check. Under the governing plan, that qualification step is replaced by the W3 and W4 route anyway.
