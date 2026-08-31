# CR9D-ABS-060 acceptance

**Status:** Accepted for the exact effect-free local snapshot
**Date:** 2026-08-29
**Depends on:** CR9D-ABS-000 through CR9D-ABS-050, ADR-058, ADR-059, ADR-060

## Delivered

- Strict digest-bound records for an exact public unauthenticated RSS/sitemap source set, bounded request, strong-approval binding, simulation or owner-live authorization, claim, pre-read marker, cleanup receipt, transport result, and terminal outcome.
- A request boundary that fixes public HTTPS endpoint identity, denies redirects/cookies/authentication/credentials, caps sources/items/bytes/runtime, fixes cost at zero, forbids raw-body retention, and grants no execution or publication authority.
- Explicit separation between fake simulation authorization and possible future owner-live authorization. The only implemented coordinator accepts simulation authorization and injected results; it rejects owner-live authority and contains no network construction path.
- A scope-bound HMAC-authenticated SQLite ledger with strict schema identity, authenticated full-state metadata, immutable request/approval/authorization records, append-only claim versions, exact replay, and deletion/tamper detection.
- Claim-before-transport and pre-read marker state transitions. Restart or uncertain evidence after the marker becomes terminal ambiguity with no automatic retry.
- Cleanup evidence that records closed handles and the absence of temporary files, credentials, cookies, and retained raw content.
- An owner-readable packet defining the exact later approval, endpoint, privacy, cost, time, cleanup, and evidence conditions.

## Acceptance assertions

- A schedule declaration, news proposal review, local work materialization, or simulation result cannot authorize a live read.
- Only a non-synthetic strong owner approval bound to the exact operation can produce an `owner_live` authorization, and that authorization still grants no command, lease, execution, or publication authority.
- Sources are unique, canonically ordered, public HTTPS RSS/sitemap endpoints with exact origin/host/path identity and no query, fragment, credentials, private host, IP literal, or redirect allowance.
- The fake coordinator cannot accidentally perform a live read because it has no network client and rejects the owner-live authorization mode.
- A marked claim can settle once only. Exact replay makes zero calls; changed replay fails closed.
- Definite pre-response failure stops later sources. Every post-marker uncertainty becomes terminal ambiguity and cannot retry.
- Raw bodies are absent from transport result and outcome schemas. Result handoff rejects accessors and Proxies without executing traps.
- Cross-scope use, digest drift, malformed chronology, over-limit evidence, schema drift, wrong integrity key, authenticated-row deletion, and outcome deletion fail closed.

## Verification

- New CR9D-ABS-060 adversarial tests: 6/6 passed.
- Combined CR9D focused gate: 38/38 passed.
- Repository pretest: 240/240 passed.
- Main suite: 416 total, 414 passed, zero failed, two intentional platform skips.
- Type checking, full lint, production build, two rendered-route tests, migrations through 0026/96 PostgreSQL tables, and diff whitespace validation passed.

## Explicit non-events

No live feed, sitemap, newsletter, Gmail account, source account, credential, network request, redirect, cookie, provider/model call, cost, timer, monitor, background process, agent run, work-item creation, publication, ABS website mutation, deployment, GitHub commit, or push occurred.

## Next boundary

CR9D-ABS-070 uses Sol/high. It may build a publication-preparation package and destination-idempotency contract using local fakes. It must not publish or mutate the public ABS website.
