# Workflow journey lane — Idea Lab and article-to-research (issue #208)

Two attributed product journeys, driven through the real services the private product
shell calls. They are prepared as a CI lane here; registration is an integration step
(this reservation may not edit `package.json`).

## What these journeys prove

| Acceptance requirement | Where it is proven |
| --- | --- |
| Bounded multi-participant panel retains every contribution | `idea-lab-attribution.journey.ts` — `panel completed with retained attribution` (8/8 turns, each bound to participant + round, `providerContacted=false`, `retryPermitted=false`) |
| Visible partial failure, no retry | `partial failure stayed visible` — round 2 loses one provider outcome → run state `ambiguous`, safe code `provider_outcome_unknown`, the lost turn stays an `ambiguous` attempt, every turn that landed before it is retained and nothing after it is, no project created |
| Owner decision creates a normal project, no execution | `owner decision created the project` — exactly one project, attributed to `sourceIdeaSessionId`, `automaticDecision=false`, `providerContacted=false`, `liveBotContactAuthorized=false`, contributions unchanged, replay idempotent |
| Owner boundary holds | `owner boundary refused both unauthorised principals` — unknown subject → `owner_boundary_unavailable` (no active identity to evaluate), authenticated non-owner with only an `operator` grant → `owner_forbidden`; neither creates a project or restarts work |
| Configurable attributed articles become proposed tasks | `article-attribution.journey.ts` — four attributed cases cover exactly the four product article actions (`research_brief`, `setup_guide`, `product_comparison`, `news_article_draft`) |
| Review/revision path, no publishing or installation | `proposal built` / `draft prepared` / `preview` — `status=draft`, `requiresOwnerReview=true`, `createsWorkItem=false`, `saved=false`, `dispatch=not_requested` |
| Attribution survives task creation | `draft prepared` — story id, story digest, proposal id, proposal digest, canonical URL, evidence digest, source label and the untrusted-evidence / no-authority notices are retained verbatim in `instructions` |
| Safe article actions on an unverified source | `review-only action gate` — a `review_only` story refuses every action except `research_brief` (`unsupported_action`), and its allowed proposal is verification-first |

Retained attribution is the point of both journeys: every case carries its own
publishing surface, observation time and source identity, and every assertion reads the
attribution back out of the product record rather than restating the input.

## How to run

From the repository root:

```bash
node --import tsx scripts/workflow-journeys/run-workflow-journeys.ts
node --import tsx scripts/workflow-journeys/run-workflow-journeys.ts --journey=idea-lab-attribution
node --import tsx scripts/workflow-journeys/run-workflow-journeys.ts --evidence-file=.hermes/journey-evidence.json
```

The driver prints one `ok`/`note` line per step and exits non-zero if a journey fails.
The journeys use the standard `PGlite` web fixture (`tests/helpers/web-foundation.ts`):
real migrations, real coordinator / registry / synthesis / owner-decision services and the
real news proposal→draft→preview functions. No provider, credential, live feed, network
call, publication or installation is involved.

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

## Accessibility shell defect fixed inside these reserved paths

`private-app/app/idea-workspace.tsx` and `private-app/app/news-workspace.tsx` were the
only private pages that returned a bare fragment instead of the shared `.private-shell`
wrapper, so the shell's control-size and focus CSS never applied to them. The private
accessibility browser run measured `All saved ideas` at 97x20 and `Refresh saved
discussion` at 163x23 there and reported the pages as not accepted, and the ideas list
route carried no `aria-current="page"`. Both pages now render inside `.private-shell`,
the saved-ideas nav link is announced as the current page and carries an explicit 24px
target floor. No behaviour, copy, request or state change.

## Not driven here (honest limits)

- Browser rendering of these two journeys at 360px and 1280px, keyboard operation, and
  back/forward/reload. The private journeys are covered by the existing browser lanes
  (`pnpm test:browser:private`, `tests/browser/workspace/product-browser-journeys.test.mjs`);
  this lane is a service-level journey lane and does not claim browser coverage.
- No live provider, feed, publication, installation, migration or production effect is
  exercised or claimed by either journey.

## Observed evidence

2026-09-16, worker `ziggy-results-01`, issue #208 accepted claim (request
5702474650, base `f1bb85c`): 2 journeys, 25 steps, 0 failed — 7 idea-panel steps and
18 article steps. The full step-by-step output is reproduced in the handoff comment on
the pull request.