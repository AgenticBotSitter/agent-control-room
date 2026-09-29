# Task 50 — owner browser journey deflake

## Outcome

Fixed the intermittent owner-review attestation race in both browser journeys.
The tests now wait for the exact `Review this exact result` state, the product
panel's `data-state="ready"` marker, and an enabled attestation control before
checking it; they then require the Accept button to become enabled. The test
helper deterministically holds the one review-options request until the
product's `data-state="loading"` marker is visible, then releases it. No fixed
sleep remains in either browser spec.

The product did not silently discard an already-delivered checkbox change: the
source showed that the intermittent behavior was the test's conditional
pre-load check. The product change is the minimal observable loading/ready
marker needed to make browser ordering explicit.

## Changes

- `private-app/app/task-owner-review.tsx`: expose `data-state="loading"` and
  `data-state="ready"` at the review-load boundary.
- `tests/browser/owner-review-readiness.ts`: add the test-only deferred
  review-options request gate and deterministic ready-control helper.
- `tests/browser/adversarial-owner.spec.ts` and
  `tests/browser/mac-local-owner-journey.spec.ts`: use that helper before each
  attestation interaction; replace fixed sleep polling with observed state.
- `tests/mac-local-human-verification-pages.test.tsx`: assert both markers in
  the unit-level delayed-load coverage.

## Verification

- `pnpm check` — passed.
- `pnpm run check:demo` — passed.
- `node scripts/run-tests-with-quarantine.mjs --import tsx --test tests/mac-local-human-verification-pages.test.tsx` — passed, 4/4.
- `node scripts/check-test-lane-coverage.mjs` — passed: all 510 test files are reachable.
- `pnpm lint` — unavailable: no `lint` package script exists.
- `pnpm eslint …` — unavailable: ESLint 9 found no repository ESLint config.
- Local browser/PostgreSQL journey — not run: this task has no authorized local PostgreSQL port block.

DB-VERIFIED: no (no port block)

## CI attack evidence

The temporary 10-way `owner-browser-journey` matrix ran both browser specs at
`537a632f228709e2d194d1034926f4a147eafd99`. All ten entries completed with
`success` in [CI run 36500691722](https://github.com/AgenticBotSitter/agent-control-room/actions/runs/36500691722).
The overall workflow was cancelled only after those ten completed browser jobs
were green, to stop unrelated full-suite lanes. The temporary matrix is
reverted in the final branch diff.

## Mutation checks

- Removed `data-state="ready"` from `OwnerReviewPanel` and ran the focused
  human-verification test. It failed in the static ready-marker assertion and
  the delayed-target ready-marker assertion. Restored the marker; the same
  test passed 4/4.
- The deferred browser gate deliberately holds the review-options request
  until `data-state="loading"` is observed. The owner interaction helper is
  the release-side readiness guard; CI executes this slowed path for both
  specs in all ten matrix entries.
- The pre-guard revision omitted the `Request changes` enabled wait while
  retaining the same delayed-review hook. Its CI job failed at the scripted
  double action because the button had not yet enabled; the succeeding 10/10
  matrix above includes the restored enabled-control wait. This is the
  requested remove-the-wait failure proof.

## Self-review

Independent self-review completed: ready once the final PR head's CI passes.
It found no source, security, final-workflow, or private-name findings, and
confirmed the focused test (4/4), absence of fixed-sleep APIs, zero final
workflow diff, the ten successful browser jobs, and the pre-guard failure.

## Final delivery

Pending synchronization with `origin/main`, PR creation, and final head SHA.
