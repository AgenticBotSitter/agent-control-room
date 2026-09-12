# Hermes contribution review — 2026-09-09

Read-only review: no PR comments, merges, worker patches, R2 changes or live
qualification performed. Public PR heads and the named bots' R2 reports were read.
Review follows control-room-delegation-review: reported host evidence remains
reported unless independently reproduced. No raw credentials retained here.

## Johnny5

PR #6, head 6c44a8fdd9232ba07a03787e0b03b45556cb5850, targets
codex/component-batch-4. Its only change is SETUP.md. No code defect found in that
patch. Suitable as attributed Linux rehearsal evidence, not production acceptance.
The R2 summary and PR body agree on 57 compiled, 30 demo, 2 compiled-demo passes,
an automated Chromium journey, occupied-port failure and cleanup. Raw host logs
and screenshots were not present in the scoped R2 folder, so these are Johnny5's
reported observations, not an independent replay. Do not close broader acceptance
based solely on a documentation edit. Coordinate SETUP.md with PR #7.

PR #7, head 9cc116a44486be4bb807a979aa09a30bfa9a1823, targets the same branch.
Hold for changes. Findings in contributor-demo/browser-acceptance.mjs:

1. **P1, line 72:** `process.stdout.write(chunk)` forwards the same output from
   which lines 73–74 extract the owner login code. This contradicts the no-code-in-
   logs requirement and PR/SETUP claims. Suppress raw child output and test with
   split-chunk synthetic codes. Treat existing runner logs as potentially containing
   a disposable login code; do not publish them without checking/redaction.
2. **P1, lines 243 and 263–284:** both failure scenarios abort a POST before it
   reaches the server. Neither simulates an accepted write with its response lost.
   `recheck-does-not-auto-repeat` unconditionally passes true. Deliver the request,
   discard only its response, assert authoritative outcome and request counts, and
   compare original/retry URL, body and idempotency key explicitly.
3. **P2, lines 90–94 and 304:** stopDemo clears its handle after either exit or an
   eight-second timeout; `!demo` then always passes, without proving process exit.
   A failed HTTP request is not proof that a port is bindable. Bind cleanup evidence
   to the owned child and exact temporary directory; report timeout as uncertainty,
   not successful cleanup. Do not infer owned directory by the first global temp
   directory added by any concurrent process (lines 86–87).
4. **P2, journey coverage:** project/task fields are reached with `.click()`, so
   the whole journey is not keyboard-only. Optional navigation branches can skip
   route checks, swallowed click failures obscure coverage, and no assertion proves
   simultaneous two-project tab isolation or archive. Require these checkpoints;
   count mutations for history/no-rerun assertions. The stated 31 passes do not
   establish the issue's full acceptance requirements.

The skip-link change itself is useful; the unsafe/incomplete acceptance runner is
why the complete PR is not accepted. Existing build-test file modification is also
outside the issue's literal new-test path wording and needs maintainer scope acceptance.

## Marvin

R2 notice-review-478e719.md challenges actual pinned source and retained original
texts. Its later addendum reports prepared-dependency execution: six dedicated
license subtests, three notice checks, and TypeScript passed. Useful independent
notice evidence, not complete license/distribution clearance.

Corrections needed to the report: label the opening no-install/runtime-blocked
sections as historical Phase 1; they are superseded by the install/test addendum.
The statement that test:queue needs managed PostgreSQL is inaccurate for this
fixture-based command. Package/lock hashes bind the snapshot inputs, not every
property of a commit or all possible inventory omissions. Runtime assertions are
checks, not protection against an author changing both assertions and metadata.
The requested clearer wording, 189 root texts plus four retained exceptions, is
reasonable. The entities 2.2.0/3.0.0 discrepancy remains unresolved.

## Ziggy

R2 Windows report at cf9197d is valuable negative evidence; no GitHub PR exists.
It reports 30 compiled passes, 24 failures and 3 skips, explicitly untriaged. Do not
claim Windows acceptance. Positive server-side curl flow and an Edge login render
do not prove the full interactive journey or Ctrl+C cleanup.

Specific reported defects align with current source assumptions:
- exact-byte hashes versus CRLF conversion; no committed .gitattributes policy;
- retained pnpm physical paths differ on Windows (four shortened peer folders);
- an unconditional symlink fixture needs Windows privilege;
- POSIX Herdr fixtures encounter Windows path normalization/platform boundaries;
- source notices are not yet wired into the built release output.

Next deliverable: one Windows portability packet with LF policy, platform-local
inventory handling without weakening identity checks, independently separated
symlink/resource tests, appropriate optional-port platform tests, and a categorized
log of all 24 compiled failures. Native Windows support must not be claimed simply
by skipping failures. Preserve the failed baseline. Ziggy's token-policy blockage
is reported, not independently tested; use owner-approved credential repair, not
relaxed organization protection. R2 is a viable report handoff meanwhile.

## Recommended integration order

1. Correct PR #7's code-output leak and false acceptance checks before accepting it.
2. Accept PR #6 only as attributed Linux evidence after normal merge authorization.
3. Give Ziggy the cohesive Windows portability/triage packet; do not mark it done.
4. Retain Marvin's notice review with the report corrections and unresolved scope.
5. Reconcile the shared SETUP.md changes, then integrate against the current
   component branch and rerun local checks. No Actions jobs needed.

Nothing was merged, published, sent to workers or changed in their R2 folders by
this review. These are review dispositions and proposed follow-ups, not dispatched jobs.
