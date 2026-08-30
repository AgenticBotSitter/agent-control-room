# CR9B-WF-040 acceptance

**Disposition:** Accepted for the exact effect-free local snapshot
**Date:** 2026-08-29
**Live storage:** Not attempted and not authorized

## Delivered

1. Two exact logical store identities separate local-private and R2-private objects without exposing physical identity.
2. Broker-private locator custody leaves only a digest reference in the control plane.
3. Artifact identity, store-specific immutable object-key identity, plan, reservation, outcome, retention, and cleanup digests are deterministic and replay stable.
4. Capacity remains a short-lived proposal and grants no write authority.
5. The lifecycle graph has no direct deletion or ambiguity-retry transition.
6. Exact size and content-digest mismatch quarantines the artifact.
7. Only one definite pre-marker retry is allowed; post-marker uncertainty and restart are terminal ambiguity.
8. Retention produces due-date owner-review candidates only, while legal hold blocks cleanup candidacy.
9. Cleanup receipts cannot resolve locators, delete objects, or become deletion evidence.
10. Exact input boundaries reject behavior-bearing objects, digest aliases, identity drift, locator-shaped additions, secret-shaped material, accessors, and Proxies.

## Negative authority

The accepted implementation contains schemas, deterministic builders, parsers, and a pure observation evaluator. It contains no local storage adapter, R2 adapter, filesystem call, network call, Cloudflare client, bucket/account/endpoint value, path, signed URL, credential reference, resolved credential, artifact byte buffer, delete operation, upload, publication, native process, or deployment behavior.

`simulated_verified` means only that injected digest and size metadata matched the declared artifact. It is not proof that an object exists, is readable, is durable, passed media QC, passed Completion Gate, or can be published.

## Verification

The combined CR9B focused gate passes 29/29, including 12 WF-040 adversarial tests. Repository pretest passes 285/285. The main suite reports 416 total, 414 passed, zero failed, and two intentional platform skips. Type checking, full lint, production build, two rendered-route tests, all 96 PostgreSQL tables through migration 0026, and diff validation pass.

## Residual gates

- WF-050 must prove a fake adapter against the frozen port without broadening it.
- Any real local adapter requires a separately reviewed private root and native file-identity controls.
- Any real R2 adapter requires exact private account/bucket/endpoint identity, credential-broker custody, network policy, and owner authorization.
- Real deletion requires protected approval, effect claim, marker, object-store receipt, reconciliation, legal-hold proof, and an independent retention policy.
- Real media remains blocked behind QC, Completion Gate, native tool, benchmark, scheduling, and later publication gates.
