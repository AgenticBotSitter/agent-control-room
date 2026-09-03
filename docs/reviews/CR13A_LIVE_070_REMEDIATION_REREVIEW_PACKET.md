# CR13A-LIVE-070 private-loopback framing remediation re-review packet

**Mode:** independent re-review, report only
**Immutable integration base:** `a6c08e1553cbb6d3e3db0e262a5e115c8356c664`
**Rejected product:** `ff00d3ffdcc5afd59bc0cc31d8a29e685fb6d587`
**Immutable remediation target:** `8e4c20da7166d48cb22c06fd38dfe87ee0016a02`
**Rejected report:** `docs/reviews/CR13A_LIVE_070_INDEPENDENT_REVIEW.md`, SHA-256
`91f9e00c41d7b3a47efab3619d6ac33dee5236c34f6c151c6ca94d42a9487ae6`
**Reviewer:** must be different from the producer and the first CR13A-LIVE-070 reviewer
**Required model / effort:** `gpt-5.6-sol` / `xhigh`
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether exact remediation `8e4c20da7166d48cb22c06fd38dfe87ee0016a02` closes Medium M-001 and M-002
plus Low L-001 and L-002 without introducing a new High, Medium, or Low defect in the bounded, effect-free
private-loopback framing contract.

Review both:

```text
git diff ff00d3ffdcc5afd59bc0cc31d8a29e685fb6d587..8e4c20da7166d48cb22c06fd38dfe87ee0016a02
git diff a6c08e1553cbb6d3e3db0e262a5e115c8356c664..8e4c20da7166d48cb22c06fd38dfe87ee0016a02
```

Principal paths are `src/connection-registry/v1/private-loopback-framing.ts`,
`tests/connection-enrollment-private-loopback-framing.test.ts`, the rejected report and this packet,
`CR13A_LIVE_070_PRIVATE_LOOPBACK_FRAMING_ACCEPTANCE.md`, BUILD_STATUS, build plan, and ADR-156. Treat remediation tests
and documents as claims to attack.

## Mandatory closure questions

1. Does module-private provenance prevent an exact caller-built clone or any caller-recomputed SHA record from passing
   protected parsing or LIVE-060 reduction? Is the accepted object frozen before it is branded and released, and does
   legitimate repeated parsing preserve that identity?
2. Does protected parsing independently re-extract the delivery ID from the exact raw frame and require equality before
   reduction? Can changed raw bytes, byte count, listener identity, routing hint, authority field, or recomputed digest
   bypass that comparison?
3. Does duplicate-aware preflight reject repeated members in every object before routing extraction, including duplicate
   outer `type`/`body`, body `deliveryId`, nested members, and direct-versus-Unicode-escape-equivalent property names?
   Are equal names in separate objects still accepted?
4. Is duplicate scanning bounded and iterative under the protocol byte ceiling, with linear expected key tracking and no
   recursion, callbacks, getters, Proxies, input-retained objects, or parser-precedence ambiguity?
5. Is Low L-001 corrected honestly: exact host `Uint8Array`, full ordinary backing-store coverage, synchronous private
   copy, and no caller-buffer retention rather than an impossible exclusive-ownership claim? Does post-push mutation
   through a second full view leave the decoded result unchanged while partial/shared/detached/behavioral views fail?
6. Does `git diff --check` pass over the complete integration-base-to-remediation diff, closing L-002 while retaining
   the rejected product and negative report as immutable history?
7. Do original prefix arithmetic, allocation ceilings, fatal UTF-8, frame/chunk bounds, exact configuration, terminal
   success/failure, internal wipe, runtime-replacement containment, and disabled local-listener properties remain intact?
8. Does the protected handoff still grant no approval, network, command, lease, or execution authority, and does
   reduction still yield exactly `rawFrame` plus the untrusted `deliveryId` for independent LIVE-060/LIVE-050/LIVE-030
   enforcement?
9. Does the product still contain no app/HTTP/browser mutation route, socket bind, network/process import, SSH launch,
   credential access, provider call, native action, production database contact, deployment, DNS, or other external
   effect?
10. Do exact counts reproduce as 23/23 focused, 65/65 connection, 769/769 pretests, 419/421 core with the two established
    platform skips, 316/316 posttests, 4/4 rendered checks, and 36 migrations/119 PostgreSQL tables? Is every original
    finding closed with no new High, Medium, or Low defect?

## Required reproduction

Run from a clean disposable checkout at the immutable remediation target with prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
pnpm run check
pnpm run lint
pnpm run test:cr13a-loopback-framing
pnpm run test:cr13a-connections
pnpm test
pnpm run test:build
pnpm run db:verify
git diff --check a6c08e1553cbb6d3e3db0e262a5e115c8356c664..8e4c20da7166d48cb22c06fd38dfe87ee0016a02
```

Add private disposable read-only probes outside the product tree for exact-clone and caller-recomputed-digest forgery,
raw-frame/routing mismatch, duplicate outer/body/nested and escape-equivalent keys, many distinct bounded keys,
full-buffer alias mutation after `push`, fragmented prefix and UTF-8, trailing/multiple frames, state transitions,
behavioral values, and runtime replacement. Do not mutate the shared checkout, start the app, bind a listener, open SSH,
contact Hermes/provider/production PostgreSQL, read credentials, deploy, or publish protected evidence.

## Required report

Return report text for architect placement at `docs/reviews/CR13A_LIVE_070_REMEDIATION_REREVIEW.md`. Include exact
targets, independence, command outcomes, explicit closure status for M-001, M-002, L-001, and L-002, findings ordered
High/Medium/Low with file/line evidence and required remediation, answers to all ten questions, product/effect/cleanup
confirmation, and one disposition. `accepted` requires no High, Medium, or Low finding. Any failure, uncertainty, or
incomplete attack is `rejected`. The report grants no integration, listener, connection, SSH, credential, native,
provider, production, deployment, DNS, or network authority.
