# Workflow journey lane — Idea Lab and article-to-research (issue #208)

Three attributed product journeys, all driven through the real services the private
product shell calls, plus one browser acceptance lane that drives the compiled product
at 360px and 1280px. The journey lane is prepared as a CI lane here; registration is an
integration step (this reservation may not edit `package.json`).

## What these journeys prove

| Acceptance requirement | Where it is proven |
| --- | --- |
| Bounded multi-participant panel retains every contribution | `idea-lab-attribution.journey.ts` — `panel completed with retained attribution` (8/8 turns, each bound to participant + round, `providerContacted=false`, `retryPermitted=false`) |
| Visible partial failure, no retry | `partial failure stayed visible` — round 2 loses one provider outcome → run state `ambiguous`, safe code `provider_outcome_unknown`, the lost turn stays an `ambiguous` attempt, every turn that landed before it is retained and nothing after it is, no project created |
| Owner decision creates a normal project, no execution | `owner decision created the project` — exactly one project, attributed to `sourceIdeaSessionId`, `automaticDecision=false`, `providerContacted=false`, `liveBotContactAuthorized=false`, contributions unchanged, replay idempotent |
| Owner boundary holds | `owner boundary refused both unauthorised principals` — unknown subject → `owner_boundary_unavailable` (no active identity to evaluate), authenticated non-owner with only an `operator` grant → `owner_forbidden`; neither creates a project or restarts work |
| Configurable attributed articles become proposed tasks | `article-attribution.journey.ts` — four attributed cases cover exactly the four product article actions (`research_brief`, `setup_guide`, `product_comparison`, `news_article_draft`) |
| Proposal-only draft before the save | `proposal built` / `draft prepared` / `preview` — `status=draft`, `requiresOwnerReview=true`, `createsWorkItem=false`, `saved=false`, `dispatch=not_requested` |
| Task creation through the protected save route | `protected save` in `article-attribution.journey.ts` — every case is saved through the real `POST /api/v1/projects/:projectId/tasks/from-news` route (`createTaskHttpHandler` + `WebTaskService`) and read back through the same service |
| Attribution survives task creation | `draft prepared` and `saved task keeps its article attribution` — story id, story digest, proposal id, proposal digest, canonical URL, evidence digest and source label are retained verbatim in the prepared `instructions` **and** in the task read back out of canonical storage |
| Safe article actions on an unverified source | `review-only action gate` — a `review_only` story refuses every action except `research_brief` (`unsupported_action`), and its allowed proposal is verification-first |
| A save starts no agent work | `no execution, publication or installation started` — 0 attempts, 0 execution plans, every saved request stays `draft`, the only audit action is `tasks.propose`, and another project reads 0 tasks; an exact replay returns the original receipt and a changed proposal under the same command identity is refused with 409 |
| Protected owner review, no revision started | `review-revision-lineage.journey.ts` — `protected owner review recorded`: the review route refuses an unauthenticated call (401) and records `changes_requested` with `startsRevision=false` through the compiled two-role application |
| Revision lineage | `revision prepared with full lineage` — a new proposed child job carries root subject/target, source run, source target digest, source content hash, review id and `revisionNumber=1`, with `startsWork=false` and `executionAvailability="requires_separate_assignment_and_approval"` |
| Review/revision leaves the source alone | `source work and native executor untouched` and `replay is inert` — source job/attempt/lease/target/checkpoint unchanged, 0 native calls and 0 effects added, one audit record, an exact replay returns the same receipt and plans nothing new |
| Back/forward/reload, keyboard operation, 360px/1280px | `browser-journeys.mjs` — see below; 33 checks against the compiled product |

Retained attribution is the point of the journeys: every case carries its own
publishing surface, observation time and source identity, and every assertion reads the
attribution back out of the product record rather than restating the input.

## Journey lane — how to run

From the repository root:

```bash
node --import tsx scripts/workflow-journeys/run-workflow-journeys.ts
node --import tsx scripts/workflow-journeys/run-workflow-journeys.ts --journey=idea-lab-attribution
node --import tsx scripts/workflow-journeys/run-workflow-journeys.ts --evidence-file=.hermes/journey-evidence.json
node --import tsx scripts/workflow-journeys/run-workflow-journeys.ts --worker=ziggy-results-01
```

The driver prints one `ok`/`note` line per step and exits non-zero if a journey fails.
The journeys use the standard `PGlite` web fixture (`tests/helpers/web-foundation.ts`):
real migrations, real coordinator / registry / synthesis / owner-decision services, the
real news proposal→draft→save functions and the real protected review/revision routes.
No provider, credential, live feed, network call, publication or installation is involved.

`--worker` is **opt-in and validated**: generated evidence carries no worker field unless
the caller passes a bare worker-id, and anything else is refused with exit code 2. A
maintainer or CI run therefore cannot inherit a contributor's attribution from a checked-in
default.

## Browser acceptance lane

`scripts/workflow-journeys/browser-journeys.mjs` drives the **compiled** product
(`dist-vps`) in Playwright, connected to the built Request handler by route interception:
no listener, no remote request, no production credential, no native agent, all state in
one disposable PGlite database seeded through the real stores.

It exists because the acceptance for these pages is browser behaviour, and the private
accessibility lane cannot supply it: that lane still carries a hard-coded expected-defect
entry for `/ideas` (`no aria-current=page for /ideas; All saved ideas 97x20, Refresh saved
discussion 163x23` — see `scripts/private-accessibility-browser-acceptance.mjs`), so its
541/541 result is not evidence for these two pages. This lane measures them itself.

```bash
pnpm build
PLAYWRIGHT_MODULE=/abs/path/to/playwright \
  node --import tsx scripts/workflow-journeys/browser-journeys.mjs
# optional: PRIVATE_BROWSER_SCREENSHOT_DIR=/abs/dir writes sanitized screenshots
```

It drives, from the compiled product:

- the ideas list and the protected panel detail inside the shared private shell, with
  exactly one `aria-current="page"` announcement and the 24px control floor held at 360px;
- keyboard activation of a panel link into its detail, the owner decision form through the
  real protected `/api/v1/ideas/:id/decision` route, and the promoted project workspace;
- **browser back and reload** across the list → detail → promoted project path, each time
  re-reading the restored state instead of trusting the in-page state;
- the partial-failure panel shown as uncertain rather than completed;
- the article journey: the saved stories list, keyboard activation of an article action,
  the research form's `prepare` command, and the protected `tasks` save that reports a
  review-only task with no bot started;
- that the whole run crossed the protected command boundary exactly three times, that the
  save carried an idempotency key, and that **no unexpected non-2xx response** was seen;
- both workflows at **1280px** as well as 360px, with no sideways scroll at either width.

## Integration step (not done here — out of this reservation's write paths)

Register the lane so CI reaches it, then append it to the component chain:

```jsonc
// package.json
"test:workflow-journeys": "node --import tsx scripts/workflow-journeys/run-workflow-journeys.ts",
"test:components": "... && pnpm test:workflow-journeys"
```

Add the matching `run:` step to the component-lane workflow. Keep the driver invocation
(not a `.test.ts` rename): `scripts/check-test-lane-coverage.mjs` only tracks
`*.test.*` files, so renaming these files without also registering them would fail
lane-coverage rather than silently skip them.

The browser lane needs a Playwright installation CI does not currently provide, so it is
**not** part of the default chain: it is an operator-run acceptance (`pnpm build` first,
`PLAYWRIGHT_MODULE` pointing at a Playwright installation with a Chromium headless shell),
exactly like `pnpm test:browser:private`. Registering it is an integration decision about
CI-provided Playwright, not a lane this reservation can wire up.

## Accessibility shell defect fixed inside these reserved paths

`private-app/app/idea-workspace.tsx` and `private-app/app/news-workspace.tsx` were the
only private pages that returned a bare fragment instead of the shared `.private-shell`
wrapper, so the shell's control-size and focus CSS never applied to them. The private
accessibility browser run measured `All saved ideas` at 97x20 and `Refresh saved
discussion` at 163x23 there and reported the pages as not accepted, and the ideas list
route carried no `aria-current="page"`. Both pages now render inside `.private-shell`,
the saved-ideas nav link is announced as the current page and carries an explicit 24px
target floor. No behaviour, copy, request or state change.

The pages' now-correct state is measured by the browser lane above, not by the
accessibility lane, which still asserts the pre-fix defect for `/ideas`.

## Not driven here (honest limits)

- No live provider, live feed, publication, installation, migration or production effect
  is exercised or claimed by any journey or by the browser lane.
- The reviewed result the revision journey plans from comes from the existing synthetic
  native completion fixture (`tests/helpers/native-quality-completion.ts`); it is named in
  the journey findings rather than presented as a live agent run.
- The browser lane drives the compiled handler in-process over route interception. It
  proves the product's own behaviour, not a deployed network topology.
- The accessibility lane's expectation for `/ideas` and `/news` is still the pre-fix
  defect. Rewriting that lane is outside this reservation's write paths; it is reported
  here rather than edited.

## Observed evidence

2026-09-16, issue #208 accepted claim (request 5702474650, base `f1bb85c`), correction
round: **3 journeys, 37 steps, 0 failed** — 7 idea-panel steps, 24 article steps and 6
review/revision steps — and **33/33 browser checks passed** against the compiled product
(`pnpm build`; Playwright 1.62.1, Chromium headless shell 151.0.7922.34). `pnpm check`,
`pnpm test:ideas`, `pnpm test:articles`, `pnpm test:product-shell`, `pnpm check:demo` and
`node scripts/check-test-lane-coverage.mjs` pass on the submitted head. The full
step-by-step output is reproduced in the handoff comment on the pull request.