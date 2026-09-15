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
5. cleans up its context, browser, application and temporary data on exit.

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

## Honest evidence

This document and the script declare every journey simulated. No claim of a
live agent, provider or external network call appears in the evidence; if any
text here ever stops saying so, the change is a defect and must be reverted.

## Acceptance

Running the script and the test plus the existing lanes listed in issue #214
(`pnpm test:results`, `pnpm check:demo`, `pnpm test:product-shell`,
`node scripts/check-test-lane-coverage.mjs`) is acceptance. An independent
read-only reviewer checks the exact submitted commit before the first push.
