# CR9D-ABS-070 acceptance

**Status:** Accepted for the exact effect-free local snapshot
**Date:** 2026-08-29
**Depends on:** CR9D-ABS-000 through CR9D-ABS-060, ADR-058 through ADR-061

## Delivered

- Exact publication destination, immutable article package, high-risk request, strong-approval binding, simulation/owner-live authorization, effect claim, pre-effect marker, destination result, cleanup receipt, and terminal outcome records.
- Packages bind story/source evidence, artifact/content digests, revision, title/slug/excerpt, Completion Gate evidence digests, and authoritative-completion-resolution requirement while containing no draft body or credential.
- Destination identity binds the exact public origin, route prefix, adapter release, environment, and credential-reference digests without granting publication authority.
- Stable destination idempotency derived from destination identity, final article path, content revision, and content digest.
- A scope-bound HMAC-authenticated SQLite ledger with strict schema-object identity, authenticated full-state metadata, immutable preparation records, append-only claim history, replay after authorization expiry, and deletion/tamper detection.
- A fake coordinator that rejects configured-live destinations and owner-live authorization, claims and marks before the injected call, requires exact fake receipt evidence, and records no public mutation.
- A fake destination that independently absorbs the same idempotency key, proving one simulated publication across duplicate deliveries.
- An owner-readable publication packet defining the remaining live adapter, Completion Gate, node-attestation, credential, receipt, cleanup, rollback, and owner-attended requirements.

## Acceptance assertions

- Editorial acceptance, package preparation, destination configuration, and a request do not authorize publication.
- Only a non-synthetic strong owner decision bound to the exact high-risk operation can form owner-live authorization, and no owner-live runtime is implemented in this block.
- Changed content, revision, path, destination, operation, package, or evidence changes the bound identity or fails closed.
- A changed request ID cannot alias and repeat the same semantic destination publication.
- Exact terminal replay remains available after approval expiry and calls no destination.
- Definite pre-mutation rejection is terminal. Every post-marker uncertainty becomes terminal ambiguity and cannot automatically retry.
- Result handoff rejects Proxies without executing traps. Packages reject secret-shaped content and omit the draft body.
- Wrong scope/key, digest drift, row deletion, outcome deletion, added trigger, malformed chronology, receipt mismatch, and configured-live entry into the fake coordinator fail closed.

## Verification

- New CR9D-ABS-070 adversarial tests: 9/9 passed.
- Combined CR9D focused gate: 47/47 passed.
- Repository pretest: 249/249 passed.
- Main suite: 416 total, 414 passed, zero failed, two intentional platform skips.
- Type checking, full lint, production build, two rendered-route tests, migrations through 0026/96 PostgreSQL tables, and diff whitespace validation passed.

## Explicit non-events

No public ABS website, live destination, credential, network request, file publication, deployment, rollback, article mutation, live source, provider/model call, agent run, GitHub commit, or push occurred.

## Next boundary

CR9D-ABS-080 uses Sol/xhigh. It must either execute one separately owner-authorized, owner-attended exact publication rehearsal after all native evidence is accepted or record a disabled disposition. It cannot infer authority from this completed fake block.
