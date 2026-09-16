# Product browser journeys

This document is the single source of truth for the public browser acceptance
package owned by issue #214. The script and tests reference this schema:

`acr-product-browser-journeys:v1`

The package owns exactly three writable paths (issue #214 packet scopes):

- `tests/browser/workspace/**`
- `scripts/product-browser-acceptance.mjs`
- `docs/acceptance/product-browser-journeys.md`

It does **not** duplicate or rewrite any private browser acceptance script, any
product-UI code, or any worker-leased path. Playwright is resolved via
`PLAYWRIGHT_MODULE=/abs/path/to/playwright` (no `package.json` change is part
of this package).

## Simulator

Disposable PGlite database, in-memory HTTP handler, single Playwright route; no
listener, no remote request, no live agent or provider was used.

## How to run

```sh
pnpm build
node --test tests/browser/workspace/product-browser-journeys.test.mjs
PLAYWRIGHT_MODULE=/abs/path/to/playwright \
PRIVATE_BROWSER_SCREENSHOT_DIR=$(pwd)/tests/browser/workspace/evidence \
  node --import tsx scripts/product-browser-acceptance.mjs
```

The test:

1. boots the compiled product bundle (`dist-vps/`) in the same process,
2. opens one Chromium context with a 360px viewport and routes every request
   to the in-memory handler (no listener, no remote request),
3. exercises both projects end-to-end through task creation, progress, result,
   review, linked revision, complete, archive and reopen,
4. takes sanitized screenshots at wide and narrow widths,
5. drives the keyboard focus path at both widths and reports the actual
   first focusable target as observed against the compiled product,
6. exercises a lost-request and a lost-reply on the project create command
   and proves they remain distinct by replaying the exact body and
   idempotency key,
7. cleans up its context, browser, application and database on exit
   without removing any temporary profile directory the harness does not
   own.

`PLAYWRIGHT_MODULE=/abs/path/to/playwright` overrides the module lookup when
Playwright is installed outside the repo. `PRIVATE_BROWSER_SCREENSHOT_DIR` must
be an absolute path; the default is `tests/browser/workspace/evidence/`.

## Journeys

The plan is exported by `tests/browser/workspace/product-browser-journeys.mjs`
as `planProductBrowserJourneys()` and rendered with
`renderProductBrowserJourneys()`. Both functions are pure ESM and never pull
in the compiled bundle or any database dependency.

<!-- BEGIN acr-product-browser-journeys:v1 -->

<!-- END acr-product-browser-journeys:v1 -->

Run `node --import tsx scripts/product-browser-acceptance.mjs --print-plan` to
regenerate the section between the markers, or call
`renderProductBrowserJourneys()` from a small script and copy the result here.

## Out of single-process scope

Two items are documented as explicit blockers or scope notes in the journey plan:

- **Independent review by a separate author**: this is a single-worker
  Windows host with no second agent registered. The contributor handbook
  asks for a separate-author proportional review; that step is recorded
  as not performed locally and is the reviewer's job at first push.

## Bootstrap composition (revision + completion)

The package reuses the same bootstrap composition as
`scripts/private-revision-browser-acceptance.mjs` and as
`tests/vps-built-quality.test.mjs` for the completion lifecycle stage:

- `nativeQualityCompletionFixture()` (from `tests/helpers/native-quality-completion.ts`)
  owns the disposable PGlite database, the access trust, the pre-published
  result for `binding.projectId`/`binding.jobId`, and the synthetic quality
  scenario. The same literal text passed to the fixture is what the
  result-page textarea assertion compares against, declared once at the
  bootstrap site so the two cannot drift.
- `taskStartupFixture()` (from `tests/helpers/task-startup.ts`) supplies
  the startup pool and the `coordinator_test` role PGlite grants
  `SELECT` rights to on `control_harness_runs`.
- `createPrivateTaskBootstrap({ install: installPrivateApplication, openDatabase: startup.openDatabase })`
  installs the application with `quality: { ...fixture.f.ownerConfig, scenarios: [fixture.scenario] }`
  and `revisionPlanning: true`. The same `quality` configuration is the
  one `tests/vps-built-quality.test.mjs` exercises, so the bootstrap here
  exposes the same completion-capable coordinator pool.

For the completion leg the script drives the public product UI to record
`decision: accepted` on the source task result page (see the journey plan
above). Then the script invokes `installedApplication.quality.sweep(
{ projectId } )` on the **same completion-capable coordinator pool** the
dedicated harness uses; the sweep observes exactly one `ReconciledItem`
with a real `disposition: "completed"` and a real `completion` receipt.
The post-completion canonical states of `job`, `attempt` and `lease` are
read through `new CanonicalStore(startup.coordinator.client)` so the
read uses the `coordinator_test` role (the same role that locked the run
row). The script asserts `job.state === "succeeded"`,
`attempt.state === "succeeded"` and `lease.state === "released"`. A
replay of `installedApplication.quality.reconcile` against the same
input returns the same completion receipt with `replayed: true`, and the
script compares the replay's full receipt object against the receipt the
first pass stored (a deep equality on the receipt, guarded against a
null-vs-null vacuous pass), proving the receipt is canonical and
replay-safe. The public product UI
on the source task page is then reloaded and asserted to render the
saved accept-quality decision without re-issuing a protected command.

The package no longer invokes `fixture.complete()` directly: that call
in the previous round ran against `fixture.f.db` (the lifecycle
fixture's raw database) in a PGlite role without the harness-runs grant,
which is the wrong composition for the completion transition. This round
uses the bootstrap composition described above; it is the same
`TaskQualityCoordinator.sweep` / `.reconcile` path that
`tests/vps-built-quality.test.mjs` lines 59–107 exercise, against the
exact same `coordinator_test` role PGlite setup, with only surrounding
plumbing differences.

Two known honest limits are recorded by the script under the
`untested` tally and surfaced in the TAP output:

- **Revision stage (changes_requested / Prepare revised task branch)**:
  this journey drives `decision: accepted` to prove the production
  completion gate; the public product UI exposes the *Prepare revised
  task* affordance only after a `decision: changes_requested` review,
  which this journey does not record. The script does **not** drive
  `revisions.plan` via `context.request.post`; that path bypasses
  `installProtectedRequestRouting` and the literal origin hostname
  returns `ENOTFOUND`, so any direct API call would be theater. The
  controller's named reuse path
  (`scripts/private-revision-browser-acceptance.mjs` and
  `tests/vps-built-revision-planning.test.mjs`) exercises the
  `changes_requested → Prepare revised task` branch in their respective
  scopes.
- **Completion role composition**: the canonical-state read uses
  `new CanonicalStore(startup.coordinator.client)` (role
  `coordinator_test`). If that read fails — for example because the
  PGlite role grants were not set up in a future change to the bootstrap
  pool — the script records the affected state assertions as `untested`
  honestly and points at `tests/vps-built-quality.test.mjs` which uses
  the same composition in its dedicated test.

No shared helper file is modified by this package. No invented product
behavior is added.

## Honest evidence

This document and the script declare every journey simulated. No claim of a
live agent, provider or external network call appears in the evidence; if any
text here ever stops saying so, the change is a defect and must be reverted.

## Acceptance

Running the script and the test plus the existing lanes listed in issue #214
(`pnpm test:results`, `pnpm check:demo`, `pnpm test:product-shell`,
`node scripts/check-test-lane-coverage.mjs`) is acceptance. An independent
read-only reviewer checks the exact submitted commit before the first push.
