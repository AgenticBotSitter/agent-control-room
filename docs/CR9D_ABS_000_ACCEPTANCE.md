# CR9D-ABS-000 acceptance

**Status:** Accepted for the exact effect-free local snapshot
**Date:** 2026-08-29

## Delivered

- Reusable `control-room-project-workspace/v1` contract with nine fixed core sections and bounded project extensions.
- Digest-bound, redacted, negative-authority workspace and source-status projections.
- `control-room-abs-news/v1` story, source-evidence, action-catalog, and draft work-order proposal contracts.
- Eight frozen ABS article actions covering research, technical guides, comparisons, tool evaluation, ABS/editorial drafts, and monitoring plans.
- Synthetic ABS workspace with Daily Brief, news/newsletter/entity/idea/research/draft/published/audience sections.
- A visible ABS project card and responsive synthetic project workspace.
- Exact host-data snapshotting that rejects Proxy, accessor, exotic-prototype, unknown-field, secret-like, scope-drift, URL, platform, catalog, and digest attacks.

## Acceptance assertions

- Project extensions cannot replace or reorder Overview, Inbox, Work, Agents, Automations, Files and artifacts, Reviews, Activity, or Settings.
- Workspace and story URLs are presentation evidence, never fetch authority.
- A search/newsletter-only `review_only` item cannot create work.
- An article action creates only an exact draft proposal.
- A draft proposal cannot approve, create a canonical work item, dispatch, lease, fetch, install, monitor, publish, or execute.
- Platform-specific actions fail when the selected platform is outside the frozen action template.
- Exact replay preserves idempotency; changed intent changes the idempotency key.
- Live collection remains visibly disabled in the synthetic workspace.

## Verification

The dedicated CR9D gate passes 16/16. Repository pretest passes 218/218. The main suite reports 416 tests: 414 passed, zero failed, and two intentional platform skips. Type checking, full lint, production build, three rendered-route checks, migration verification through 0026/96 tables, and diff whitespace validation pass.

## Explicit non-events

No external repository code was copied. No RSS feed, sitemap, search engine, newsletter, Gmail account, website, AI provider, credential, network request, model call, background monitor, agent dispatch, native process, ABS website mutation, publication, deployment, or external effect was used.
