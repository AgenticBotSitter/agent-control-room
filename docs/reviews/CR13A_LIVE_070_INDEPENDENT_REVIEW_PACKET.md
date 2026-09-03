# CR13A-LIVE-070 private-loopback framing independent review packet

**Mode:** independent review, report only
**Immutable integration base:** `a6c08e1553cbb6d3e3db0e262a5e115c8356c664`
**Immutable product target:** `ff00d3ffdcc5afd59bc0cc31d8a29e685fb6d587`
**Reviewer:** must be different from the producer and prior CR13A-LIVE-060 reviewers
**Required model / effort:** `gpt-5.6-sol` / `xhigh`
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether exact product `ff00d3ffdcc5afd59bc0cc31d8a29e685fb6d587` safely implements one bounded,
effect-free private-loopback frame decoder and a genuinely disabled local listener port without weakening the accepted
LIVE-060 admission, LIVE-050 outer authentication, or LIVE-030 inner enrollment verification boundaries.

Review:

```text
git diff a6c08e1553cbb6d3e3db0e262a5e115c8356c664..ff00d3ffdcc5afd59bc0cc31d8a29e685fb6d587
```

Principal paths are `src/connection-registry/v1/private-loopback-framing.ts`,
`tests/connection-enrollment-private-loopback-framing.test.ts`, `src/local-pilot/v1/runtime.ts`, package test wiring,
`CR13A_LIVE_070_PRIVATE_LOOPBACK_FRAMING_ACCEPTANCE.md`, BUILD_STATUS, build plan, and ADR-156. Treat producer tests and
documents as claims to challenge.

## Mandatory questions

1. Is the unsigned big-endian prefix decoded correctly across every byte/chunk partition, without signed overflow,
   allocation before a complete header, or acceptance below 2/above the configured and protocol ceilings?
2. Can empty, numerous, oversized, partial, detached, shared, Buffer, subclass, Proxy, accessor-bearing, symbol-bearing,
   aliased, or caller-mutated chunks bypass the exact fresh-backing-store rule or execute caller behavior?
3. Can incomplete input, trailing bytes, a second frame, a post-completion chunk, repeated finish, close, or any sequence
   after failure produce a second outcome, retain usable internal state, or avoid terminal cleanup?
4. Is UTF-8 decoding fatal and exact? Can a BOM, overlong encoding, surrogate, split multibyte sequence, malformed byte,
   or JSON whitespace/duplicate/prototype-shaped key produce ambiguous raw bytes or routing state?
5. Does JSON extraction accept exactly one declared `connection.enrollment.deliver` outer key set and exact delivery body
   key set while treating the delivery ID as untrusted? Does it avoid authenticating or trusting all other frame fields?
6. Is the protected handoff byte-bounded and digest-bound over raw frame, actual UTF-8 bytes, routing hint, framing,
   listener policy, and negative authority? Can re-digesting altered fields or adding behavior create an accepted alias?
7. Does reduction to LIVE-060 produce exactly `rawFrame` and `deliveryId`, leaving outer authentication and inner
   enrollment verification unchanged and preventing the larger protected record from crossing that exact input seam?
8. Are runtime selections checked before changed JSON parse, byte length, UTF-8 decode, regex, reflection, or typed-array
   cleanup behavior can execute? Can an exception escape as a raw or unbounded value or prevent terminal cleanup?
9. Is local runtime composition actually disabled when instantiated, with no app/HTTP/browser route, socket bind,
   networking/process import, SSH launch, credential access, provider call, native action, or external effect?
10. Do exact counts reproduce as 21/21 focused, 63/63 connection, 769/769 pretests, 419/421 core with the two established
    platform skips, 314/314 posttests, 4/4 rendered checks, and 36 migrations/119 PostgreSQL tables? Is there any new
    High, Medium, or Low defect?

## Required reproduction

Run read-only checks against the immutable target with prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
npm run check
npm run lint
npm run test:cr13a-loopback-framing
npm run test:cr13a-connections
node --import tsx scripts/verify-migrations.ts
git diff --check a6c08e1553cbb6d3e3db0e262a5e115c8356c664..ff00d3ffdcc5afd59bc0cc31d8a29e685fb6d587
```

Use private disposable read-only probes outside the product tree for partition boundaries, prefix arithmetic, UTF-8/BOM,
multiple/trailing frames, state transitions, behavioral binary values, protected-record drift, runtime replacement, and
instantiated local-pilot disabled truth. Do not modify the shared checkout, start the app, bind a listener, open SSH,
contact Hermes/provider/production PostgreSQL, read credentials, deploy, or publish protected evidence.

## Required report

Return report text for architect placement at `docs/reviews/CR13A_LIVE_070_INDEPENDENT_REVIEW.md`. Include exact target,
independence, command outcomes, findings ordered High/Medium/Low with file/line evidence and required remediation, answers
to all ten questions, product/effect/cleanup confirmation, and one disposition. `accepted` requires no High, Medium, or
Low finding. Any failure, uncertainty, or incomplete challenge is `rejected`. The report grants no integration,
listener, connection, SSH, credential, native, provider, production, deployment, DNS, or network authority.
