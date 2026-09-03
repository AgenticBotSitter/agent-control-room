# CR13A-LIVE-080 listener-lifecycle remediation re-review packet

**Mode:** independent re-review, report only  
**Immutable integration base:** `b0b129824f99dbaeb86f7cc6eac4001530fbe1fa`  
**Rejected target:** `4ecc453f9ac0f6d6edb30455620d0b8fa0a90c3e`  
**Immutable remediation target:** `884ff423914ab4e442500bd194970b0713da72ca`  
**Rejected report:** `docs/reviews/CR13A_LIVE_080_INDEPENDENT_REVIEW.md`, SHA-256
`0f43e735ce30fe418dd93a4d5221497dde25b9f3c50d95c501f1322064bc7688`  
**Reviewer:** must be different from the producer and the first CR13A-LIVE-080 reviewer  
**Required model / effort:** `gpt-5.6-sol` / `xhigh`  
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether exact remediation `884ff423914ab4e442500bd194970b0713da72ca` closes Medium M-001 and Low L-001
and L-002 without introducing a new High, Medium, or Low defect in the bounded, effect-free private-loopback listener
lifecycle contract.

Review both:

```text
git diff 4ecc453f9ac0f6d6edb30455620d0b8fa0a90c3e..884ff423914ab4e442500bd194970b0713da72ca
git diff b0b129824f99dbaeb86f7cc6eac4001530fbe1fa..884ff423914ab4e442500bd194970b0713da72ca
```

Principal paths are `src/connection-registry/v1/private-loopback-listener-lifecycle.ts`,
`tests/connection-enrollment-private-loopback-listener-lifecycle.test.ts`, the rejected report and this packet,
`CR13A_LIVE_080_PRIVATE_LOOPBACK_LISTENER_LIFECYCLE_ACCEPTANCE.md`, BUILD_STATUS, build plan, and ADR-157. Treat
remediation tests and documents as claims to attack.

## Mandatory closure questions

1. Is the complete `ConnectionEnrollmentPrivateLoopbackProtectedFrameV1` never retained as lifecycle object state after
   frame validation? Are only the digest, byte count, and chunk count retained for a successful receipt?
2. Do premature `finish`, wrong-order calls after frame acceptance, observation rejection, explicit abort, mapped
   failures, incomplete shutdown, and every other terminal failure clear all reduced frame and transient timing evidence?
   Does a later call stay terminal and disclose nothing?
3. Does successful `finish` snapshot only validated primitives, clear stored evidence before constructing its receipt,
   and remain single-use? Can a receipt-construction failure or later reuse retain or recover protected frame material?
4. Does receipt parsing enforce the exact listener-ID policy bound of 27–160 characters before accepting its syntax or
   digest? Are 27 and 160 accepted and both adjacent invalid boundaries rejected without executing caller behavior?
5. Is `rehearsalReference` rederived from the already validated `planDigest` and compared for exact equality? Can a
   caller change either value, recompute the public receipt digest, and create a semantically rebound receipt?
6. Do plan creation, plan parsing, receipt parsing, and finish still re-establish the accepted runtime custody before
   selected canonicalization, reflection, pattern, typed-array, or hash behavior can run?
7. Do strict ordinary-data capture, exact keys, Proxy/accessor rejection, module-private frame provenance, listener and
   identity equality, capacity, chronological bounds, and terminal state rules remain intact?
8. Does the public receipt still expose no raw frame, delivery ID, signature, address, username, credential, host, tunnel,
   or secret-shaped material, and do all native/effect/authority claims remain fixed false under recomputed digests?
9. Does the product still contain no app/HTTP/browser mutation route, socket bind, listener, network/process import, SSH
   launch, Hermes/provider call, credential access, native action, production database contact, deployment, or DNS effect?
10. Do exact gates reproduce as 34/34 focused, 76/76 connection, 769/769 pretests, 419/421 core with the two established
    platform skips, 327/327 posttests, 4/4 rendered checks, and 36 migrations/119 PostgreSQL tables? Are M-001, L-001,
    and L-002 closed with no new High, Medium, or Low defect?

## Required reproduction

Run from a clean disposable checkout at the immutable remediation target using already prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
pnpm run check
pnpm run lint
pnpm run test:cr13a-listener-lifecycle
pnpm run test:cr13a-connections
pnpm test
pnpm run test:build
pnpm run db:verify
git diff --check b0b129824f99dbaeb86f7cc6eac4001530fbe1fa..884ff423914ab4e442500bd194970b0713da72ca
```

Add private disposable read-only probes outside the product tree for frame-bearing premature finish, every wrong-order
transition after frame acceptance, abort and mapped failure, successful-finish cleanup, listener-ID boundaries, changed
plan/reference combinations with recomputed receipt digests, behavioral values, protected-frame clones, runtime
replacement, and safe-output scanning. Do not mutate the shared checkout, start the app, bind a listener, open SSH,
contact Hermes/provider/production PostgreSQL, read credentials, deploy, or publish protected evidence.

## Required report

Return report text for architect placement at `docs/reviews/CR13A_LIVE_080_REMEDIATION_REREVIEW.md`. Include exact
targets, independence, command outcomes, explicit closure status for M-001, L-001, and L-002, findings ordered
High/Medium/Low with file/line evidence and required remediation, answers to all ten questions, product/effect/cleanup
confirmation, and one disposition. `accepted` requires all three findings closed and no High, Medium, or Low finding.
Any failure, uncertainty, or incomplete attack is `rejected`. The report grants no integration, listener, connection,
SSH, credential, native, provider, production, deployment, DNS, or network authority.
