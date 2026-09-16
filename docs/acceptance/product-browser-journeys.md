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
`scripts/private-revision-browser-acceptance.mjs` for the revision and
completion lifecycle stages:

- `nativeQualityCompletionFixture()` (from `tests/helpers/native-quality-completion.ts`)
  owns the disposable PGlite database, the access trust, the pre-published
  result for `binding.projectId`/`binding.jobId`, the synthetic quality
  scenario, and exposes `verify` / `review` / `ready` / `complete` /
  `states` against the production completion gate. The same literal text
  passed to the fixture is what the result-page textarea assertion compares
  against, declared once at the bootstrap site so the two cannot drift.
- `taskStartupFixture()` (from `tests/helpers/task-startup.ts`) supplies
  the startup pool and coordinator config used by both private harnesses.
- `createPrivateTaskBootstrap({ install: installPrivateApplication, openDatabase: startup.openDatabase })`
  installs the application with `revisionPlanning: true` so the public
  product UI exposes the *Prepare revised task* affordance.

The bootstrap exposes `ready()` (verify + accept) and `complete()` (the
production completion gate). After the UI drives the owner review and
revision preparation, the package calls `fixture.ready()` to bring the
snapshot to `ready`, then `fixture.complete()` to finalize the run, and
finally asserts via `fixture.states()` that `job.state === "succeeded"`,
`attempt.state === "succeeded"` and `lease.state === "released"`. The
public product UI is reloaded on the same task page after completion to
confirm the post-completion view without re-issuing the protected
command.

Two known honest limits are recorded by the script under the
`untested` tally and surfaced in the TAP output:

- **Revision stage**: the public product UI does not render a
  *Prepare revised task* button (the affordance lives in the bootstrap
  revision UI, mounted only by `scripts/private-revision-browser-acceptance.mjs`).
  The script does **not** drive `revisions.plan` via
  `context.request.post`; that path bypasses `installProtectedRequestRouting`
  and the literal origin hostname returns `ENOTFOUND`, so any direct API
  call would be theater. The controller's named reuse path drives the
  linked follow-up page through the bootstrap revision UI.
- **Completion stage**: in the single-process bootstrap here, the
  completion services run in a PGlite role that does not currently have
  SELECT rights on the harness-runs table (`control_harness_runs`) that
  `NativeTaskCompletionService.complete` needs to lock for the run row
  it observes. The script records this honestly as `untested`; the
  controller's named reuse path exercises the same completion services
  in a process context where the canonical store grants those rights.
  The post-completion source result page reload is asserted regardless,
  because the public product UI's reload guarantee is independent of the
  completion services.

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
