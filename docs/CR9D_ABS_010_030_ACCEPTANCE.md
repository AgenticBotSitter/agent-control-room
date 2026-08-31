# CR9D-ABS-010/020/030 acceptance

**Status:** Accepted for the exact effect-free local snapshot
**Date:** 2026-08-29
**Depends on:** CR9D-ABS-000 and ADR-058

## Delivered

- A private SQLite ABS store with an external HMAC integrity key, exact scope binding, authenticated full-state metadata, strict schema identity, and deletion/tamper detection.
- Append-only story and source-status versions, current pointers, queue history, proposal storage, stable semantic replay, restart recovery, and local archive/restore.
- Exact injected RSS, sitemap, and newsletter collectors with no endpoint, fetch method, account, credential, or network path.
- Public-HTTPS canonicalization that removes only recognized tracking parameters and rejects credentials, private/loopback destinations, ports, fragments, and semantic query parameters.
- Deterministic title clustering, canonical story selection, retained evidence, direct-verification truth, coverage counts, priority fallback, and review-only containment.
- A fake-ingestion vertical that collects, clusters, persists, records honest source status, and returns a negative-authority receipt.
- An interactive owner workspace with queue filters, priority/newest sorting, story evidence detail, local archive/restore, all eight proposal actions, platform selection, draft editing, and explicit no-work/no-dispatch state.
- A client-safe UI boundary that imports only the reducer and types; server crypto and SQLite code cannot enter the browser bundle.

## Acceptance assertions

- Restart preserves the exact current stories, source status, proposal, queue event, version history, and authenticated state digest.
- Exact story/source/proposal replay is inert; scope drift, story drift, URL ownership collisions, invalid rollback, row deletion, schema drift, and invalid integrity state fail closed.
- Search or newsletter discovery without direct verification remains `review_only` and exposes no article action.
- Deduplication cannot turn an unverified-only cluster into verified truth.
- Local archive changes project classification without rewriting or deleting retained source evidence.
- A saved browser draft is visibly a local preview, requires owner review, creates no canonical work item, and grants no approval, network, command, lease, dispatch, execution, monitoring, or publication authority.
- The injected collector-to-store vertical uses zero network and creates zero work.

## Verification

- Focused CR9D gate: 26/26 passed.
- Combined repository pretest: 228/228 passed.
- Main suite: 416 total, 414 passed, zero failed, two intentional platform skips.
- Type checking, full lint, production build, four rendered paths, migrations through 0026/96 PostgreSQL tables, and diff whitespace validation pass.
- Browser QA exercised the hydrated local route: opened a research editor, edited and saved a draft, observed the explicit no-work/no-dispatch receipt, switched to the review-only queue, and archived the item locally. Browser QA also caught and drove repair of a server-barrel import that initially pulled `node:crypto` into the client bundle.

## Explicit non-events

No live RSS, sitemap, search, newsletter account, Gmail account, source login, credential, network request, AI provider call, model spend, background schedule, monitor, canonical work creation, agent dispatch, ABS website mutation, publication, deployment, or external effect occurred. No GitHub commit or push occurred.

## Next boundary

CR9D-ABS-040/050 must use Sol/high to freeze and implement reviewed proposal materialization plus schedule/collector/monitor security and recovery contracts. It must stop before live collection, real accounts, agent execution, website mutation, or publication.
