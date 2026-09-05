# CR14B shared catalog — initial independent review

Date: 2026-09-04. Reviewer: `cr13a_live290_review`, independent of the producing agent.
The producing agent retained this report from the returned review. This is negative historical evidence,
not acceptance of a later correction.

Product: `793b8269c9695e4d38a55d79d6ce7d8b07f06d19`.
Tree: `444336d75e0f355b7b37c70c9fa68fac9bdd3055`.
Base: `59373732f659096fbcf6703fb33848be164bd46e`.

**Disposition: rejected pending one bounded fix. 0 High / 1 Medium / 0 Low.**

## CR14B-CATALOG-REV-001 — Medium: hidden source existence disclosure

The exact product's `WebProjectService.getView` resolves an existing adapter before source-specific
authorization. An ordinary wildcard reader without owner-only Idea access receives 403 for an existing
Idea ID, but 404 for an absent ID. That difference reveals the presence of a hidden Idea project through
the detail API, HTML and finite snapshot routes. The operator test checks only denial, not comparison
with an absent ID. Resolve only authorized sources, or otherwise normalize these public outcomes, and
add API/HTML/snapshot comparisons without weakening owner-only authority.

## What held

Catalog source filters, tenant/workspace selection, C-collated bounded keyset pagination, owner-role
enforcement, same-transaction session/grant checks, current Idea projection authentication, refusal to
mutate Idea rows through ordinary commands, origin/read-only UI labels, and the stated repository-only
read integration scope were coherent. The catalog test covered more than 200 mixed records.

## Independently observed verification

- Exact commit/tree/base and clean checkout confirmed.
- CR14B focused tests: 51/51 passed.
- Existing rebuilt private artifact checks: 3/3 passed; reviewer did not rebuild the artifact.
- Whitespace diff against the exact base passed.

Producer-reported main-suite, lint/build, existing Idea regression and migration evidence was not
independently rerun in this review. No files, Git refs, builds, browser, network, credentials, providers,
native listeners, host services, real PostgreSQL or deployments were changed or exercised.

Full B-WIRE, browser/hydration, real PostgreSQL and private-pilot acceptance remain outside this review.
The correction must receive a separately recorded re-review.
