# CR13A-LIVE-080 private-loopback listener lifecycle independent review packet

**Mode:** independent review, report only
**Immutable integration base:** `b0b129824f99dbaeb86f7cc6eac4001530fbe1fa`
**Immutable review target:** `4ecc453f9ac0f6d6edb30455620d0b8fa0a90c3e`
**Frozen implementation code:** `7333ea48577b1000fd5eac0e6789b3e21cfeb559`
**Superseded before review:** `c98ae8128195469d2789357df31ada18b32480e3`
**Reviewer:** must be different from the producer and all earlier CR13A reviewers
**Required model / effort:** `gpt-5.6-sol` / `xhigh`
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether exact target `4ecc453f9ac0f6d6edb30455620d0b8fa0a90c3e` safely defines the repository-fake
listener lifecycle around the accepted LIVE-070 decoder without opening a listener or overstating native truth. Reject
the target for any High, Medium, or Low defect, incomplete attack, failed command, or material uncertainty.

Review exactly:

```text
git diff b0b129824f99dbaeb86f7cc6eac4001530fbe1fa..4ecc453f9ac0f6d6edb30455620d0b8fa0a90c3e
```

Principal paths are `src/connection-registry/v1/private-loopback-listener-lifecycle.ts`,
`tests/connection-enrollment-private-loopback-listener-lifecycle.test.ts`, `src/connection-registry/v1/index.ts`,
`package.json`, `CR13A_LIVE_080_PRIVATE_LOOPBACK_LISTENER_LIFECYCLE_ACCEPTANCE.md`, BUILD_STATUS, build plan, and ADR-157.
Treat every test and document as a claim to attack.

## Mandatory review questions

1. Are configuration, plan, observation, and receipt boundaries exact ordinary-data boundaries that reject extra keys,
   symbols, missing fields, accessors, Proxies, aliases, invalid patterns, invalid bounds, and stale digest drift without
   invoking supplied behavior?
2. Does the plan fix only SSH tunnel, private IPv4 literal `127.0.0.1`, accepted single-frame framing, digest-only
   endpoint/owner/tunnel-peer/host-key/channel identities, one active connection, zero queued connections, bounded
   frame/chunk/time ceilings, one frame, and no automatic restart? Is its public SHA correctly treated as consistency
   rather than authenticity or effect authority?
3. Is the lifecycle exactly bind, open, frame, connection close, drain, and listener close? Does wrong order, invalid
   data, incomplete finish, abort, repeated finish, or any use after success/failure become terminal without a second
   receipt or retained protected frame?
4. Are active and queued connection counts enforced at every relevant phase? Are chunk count, idle age, connection age,
   drain time, and close time bounded, and are successive connection/shutdown ages prevented from moving backward?
5. Can only a LIVE-070 module-private decoder-minted protected frame for the exact same listener pass? Do exact clones,
   caller-recomputed records, frames minted for another listener, oversized frames, and invalid provenance fail before
   becoming lifecycle evidence?
6. Is the passing receipt restricted to digest/size/policy facts and free of raw frame, delivery ID, signature, address,
   host, username, credential, or tunnel material? Does it explicitly deny actual bind, exclusive port ownership,
   tunnel authentication, host-key custody, native cleanup, listener enablement, network I/O, and all effect authority?
   Can a caller change any negative literal and recompute the public digest without the parser rejecting it?
7. Do plan and receipt digest paths re-establish the accepted canonicalization/hash runtime before use? Can post-import
   replacement of a selected Object, Array, Number, JSON, Date, String, RegExp, Reflect, typed-array, or hash operation
   execute replacement behavior, escape a raw error, or produce an accepted changed result?
8. Does public-safe validation remain bounded and honest? Are lifecycle error codes from caught unknown values accepted
   only through exact local error identity plus the declared allowlist, with Proxy or unusual-prototype rejections unable
   to execute behavior or escape raw?
9. Does local-pilot wiring remain the accepted disabled listener with no new browser/HTTP route? Is there no socket bind,
   network/process import, SSH start, credential read/write, Hermes/provider call, native action, production PostgreSQL
   contact, deployment, DNS, public hosting, or other external effect?
10. Do all deterministic counts reproduce as 34/34 focused, 76/76 connection, 769/769 pretests, 419/421 core with the
    two established platform skips, 327/327 posttests, 4/4 rendered checks, and 36 migrations/119 PostgreSQL tables? Is
    the base-to-target diff whitespace clean, with no new High, Medium, or Low defect?

## Required reproduction

Run from a clean disposable checkout at the immutable review target with prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
pnpm run check
pnpm run lint
pnpm run test:cr13a-listener-lifecycle
pnpm run test:cr13a-connections
pnpm test
pnpm run test:build
pnpm run db:verify
git diff --check b0b129824f99dbaeb86f7cc6eac4001530fbe1fa..4ecc453f9ac0f6d6edb30455620d0b8fa0a90c3e
```

Add private disposable read-only probes outside the product tree for plan/receipt drift and recomputation, behavioral
objects and caught values, terminal state reuse, listener and tunnel identity mismatch, capacity overflow, zero/over-limit
chunks, idle greater than connection age, decreasing connection age, decreasing shutdown time, deadline boundaries,
cross-listener and cloned protected frames, output redaction, and representative post-import runtime replacement.

Do not mutate the shared checkout, start the app, bind or probe a port, open SSH, read credentials or Keychain, contact
Hermes/provider/production PostgreSQL, install or download anything, deploy, publish, or perform any external effect.
Clean up only the exact disposable review directory you created and confirm its absence.

## Required report

Return report text for architect placement at `docs/reviews/CR13A_LIVE_080_INDEPENDENT_REVIEW.md`. Include exact base,
target, and implementation hash; reviewer independence; command outcomes and exact counts; findings ordered
High/Medium/Low with file/line evidence and required remediation; explicit answers to all ten questions; disposable
probe summary; product/effect/cleanup confirmation; and exactly one disposition.

`accepted` requires no High, Medium, or Low finding. Any failure, uncertainty, incomplete attack, or cleanup uncertainty
is `rejected`. The report grants no integration, listener, connection, SSH, credential, native, provider, production,
deployment, DNS, public-hosting, or network authority.
