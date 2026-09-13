# Offline private ingress and owner bootstrap conformance

This package is repeatable, synthetic and effect-free. It drives the production owner-bootstrap command, bootstrap transaction, Access assertion verifier and key cache, session authority, private web process, and Node request boundary. It opens no listener, contacts no identity provider, and accepts no real identity, credential, key, owner-attendance claim or externally enforced MFA claim.

## Covered outcomes

| Boundary | Synthetic fault | Required outcome |
| --- | --- | --- |
| Owner creation | exact owner, replay, concurrency, second owner | One identity and one owner grant exist; no later attempt replaces them. |
| Bootstrap inputs | wrong database, tenant, workspace, issuer, audience, signature, expiry, abort or regressed clock | Refusal occurs without inappropriate identity or grant writes. Invalid assertions and pre-abort do not open the database. |
| Bootstrap uncertainty | lost commit acknowledgement or failed connection cleanup | The command never reports success or retries. A possibly committed owner remains the sole owner. |
| Private Node ingress | wrong Host, non-loopback peer, spoofed forwarding, duplicate or missing assertion header | The actual Node-to-web boundary refuses; forwarding metadata cannot select the configured origin. |
| Assertion keys | rotation, outage, cache freshness and backoff | Fresh keys replace expired cache state; outage has no stale fallback and requests do not force retries during backoff. |
| Current authority | identity suspension, session revocation or grant revocation | A later request rechecks stored authority and refuses. |
| Evidence | stored identity and command result | Raw subject/email, assertion, database password and key material are absent. |

Run `node --import tsx scripts/test-private-owner-bootstrap-conformance.ts` from an already prepared checkout. Adjacent lanes are `pnpm test:access`, the private configuration tests, `pnpm check:demo`, and test-lane coverage. The issue reserves no package or workflow file, so the lead registers accepted tests.

Each Node test-file process creates one migrated PGlite/WASM database and resets only its synthetic owner, grant and session rows between leased cases. A guard asserts that per-process instance ceiling; database close alone is not treated as memory reclamation.

## Interpretation limits

Success means only that one synthetic assertion created one owner in a disposable database and that injected requests followed the implemented refusal rules. The tests do not prove owner attendance, MFA enforcement, direct-origin isolation, Cloudflare configuration, deployment readiness, network behavior, credential custody, or production PostgreSQL behavior. No HTTP setup endpoint or command-line, environment, file, or standard-input credential intake is added.
