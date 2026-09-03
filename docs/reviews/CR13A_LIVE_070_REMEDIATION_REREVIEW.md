# CR13A-LIVE-070 remediation independent re-review

**Disposition:** `accepted`
**Integration base:** `a6c08e1553cbb6d3e3db0e262a5e115c8356c664`
**Rejected product:** `ff00d3ffdcc5afd59bc0cc31d8a29e685fb6d587`
**Remediation reviewed:** `8e4c20da7166d48cb22c06fd38dfe87ee0016a02`
**Rejected-report SHA-256:** `91f9e00c41d7b3a47efab3619d6ac33dee5236c34f6c151c6ca94d42a9487ae6`
**Re-review-packet SHA-256:** `5bf992f81c136b0e4f32e4095dd5eaa16a86bb29cbfda8f42cdf14215928c9dd`

## Independence and scope

This was a zero-repair, report-only review by a reviewer different from the producer and first CR13A-LIVE-070 reviewer.
Both rejected-product-to-remediation and integration-base-to-remediation diffs were reviewed.

The immutable remediation was exported into a disposable private archive. The shared checkout was not edited, committed,
switched, pushed, or otherwise mutated.

## Original-finding closure

### M-001 — Closed

Module-private provenance is implemented through the private WeakSet at
`src/connection-registry/v1/private-loopback-framing.ts:36-38`. Protected parsing requires exact membership before
inspecting the record at lines 154-165.

The decoder freezes the completed record before branding it at lines 340-345. Parsing returns the same branded,
already-frozen object at lines 185-193, preserving identity across repeated parser and reducer calls.

Independent probes confirmed:

- the returned object is frozen;
- repeated parsing returns the same object identity;
- exact caller-built clones fail;
- records with recomputed public SHA values fail after delivery ID, raw frame, listener identity, byte count, or
  authority changes;
- reduction of forged records fails;
- a record minted by one separately instantiated module cannot enter another module instance's provenance boundary; and
- Proxy input fails without executing traps.

### M-002 — Closed

The iterative scanner at lines 202-313 tracks decoded property names independently for every object. Native JSON parsing
establishes grammar first; duplicate scanning finishes before routing extraction at lines 319-337.

Independent probes rejected eight duplicate families:

- duplicate outer `type`;
- direct versus Unicode-escaped outer `type`;
- duplicate outer `body`;
- duplicate body `deliveryId`;
- direct versus Unicode-escaped `deliveryId`;
- duplicate nested members;
- direct emoji versus surrogate-escape-equivalent nested names; and
- duplicate `__proto__` members.

Equal member names in separate objects remained accepted. A frame containing 4,000 distinct keys and another containing
2,000 nested object levels were accepted within the protocol ceiling, supporting bounded iterative operation without
recursion.

### L-001 — Closed

The contract now accurately states the enforceable property: an exact host `Uint8Array` covering its complete ordinary
backing store is copied synchronously into private decoder storage, with no caller buffer retained after `push`.

Independent probes confirmed that mutation through a second full-buffer view after `push` cannot change the decoded
result. Partial views, Buffer values, SharedArrayBuffer-backed views, and Proxies failed closed, with zero Proxy trap
execution.

### L-002 — Closed

`git diff --check a6c08e1553cbb6d3e3db0e262a5e115c8356c664..8e4c20da7166d48cb22c06fd38dfe87ee0016a02`
exited `0`.

The rejected product and its negative report remain preserved as immutable history.

## Findings

### High

None.

### Medium

None.

### Low

None.

No further remediation is required for this bounded block.

## Mandatory questions

1. **Provenance and identity:** Yes. Exact clones, cross-module records, and caller-recomputed SHA records cannot pass.
   The legitimate object is frozen before branding and repeated parsing preserves exact identity.
2. **Independent routing comparison:** Yes. Parsing re-extracts the delivery ID from the exact raw frame and requires
   equality before reduction. Changed raw bytes, byte count, listener identity, routing hint, authority fields, or
   recomputed digests cannot bypass provenance and consistency checks.
3. **Duplicate members:** Yes. Duplicate outer, body, and nested members, including Unicode-escape-equivalent property
   names, fail before routing. Equal names in separate objects remain valid.
4. **Scanner bounds and behavior:** Yes. The scan is iterative, bounded by the protocol byte ceiling, and uses per-object
   Set tracking with linear expected key work. It uses no recursive descent, caller callbacks, getters, Proxies, or
   retained input-derived object.
5. **Binary handling:** Yes. The code enforces full ordinary backing-store coverage, synchronous private copying, and no
   caller-buffer retention. Later alias mutation cannot affect the result; partial, shared, detached, subclassed, Buffer,
   accessor/symbol-bearing, and behavioral values fail closed.
6. **Whitespace and history:** Yes. The complete integration diff passes whitespace validation, and the rejected product
   and negative report remain preserved.
7. **Original framing properties:** Yes. Four-byte unsigned big-endian prefix arithmetic, allocation ceilings, fatal
   UTF-8, frame and chunk limits, exact configuration, terminal success/failure, internal wipe, runtime-replacement
   containment, and the disabled local listener remain intact.
8. **Authority and reduction:** Yes. The protected handoff grants no approval, network, command, lease, or execution
   authority. Reduction yields exactly `rawFrame` and the untrusted `deliveryId` for independent
   LIVE-060/LIVE-050/LIVE-030 enforcement.
9. **External effects:** Yes. The product adds no application mutation route, socket bind, networking/process import,
   SSH launch, credential access, provider call, native action, production-database contact, deployment, DNS operation,
   or external effect.
10. **Counts and closure:** Yes. All required deterministic totals reproduced, all four original findings are closed,
    and no new High, Medium, or Low defect was identified.

## Reproduced evidence

- macOS stage zero: exit `0`, `ready_for_runtime_check`;
- lockfile SHA-256: `48af07084f582b02c5c1827e5816df9bf8a3cd8643dbd22ba041807cd9e2383a`;
- TypeScript: exit `0`;
- ESLint: exit `0`;
- focused framing/admission: `23/23` pass;
- complete connection slice: `65/65` pass;
- pretests: `769/769` pass;
- core tests: `419/421` pass with the two established platform skips and zero failures;
- posttests: `316/316` pass;
- production build: pass;
- rendered checks: `4/4` pass;
- migrations `0001`-`0036`: pass;
- PostgreSQL schema verification: `119` tables;
- integration whitespace check: exit `0`;
- independent probe groups: `8/8` pass;
- duplicate families: `8/8` rejected as required; and
- runtime-replacement selections: `10/10` contained without replacement execution.

## Reviewer-harness corrections

The first disposable dependency layout caused pnpm's automatic dependency-status installer to stop before product scripts
ran. A CI-mode correction attempted registry resolution, but sandboxed DNS failed with `ENOTFOUND`; zero packages were
downloaded and no remote endpoint was reached. That archive was discarded. A fresh archive used the already-prepared
local dependencies with pnpm's automatic installer disabled; all product scripts then ran successfully.

The first outside-tree probe used top-level await under CommonJS transformation and failed before loading the product.
Wrapping the disposable probe entry in an async function corrected the reviewer harness; the product remained unchanged.

`pnpm run db:verify` initially encountered sandbox `EPERM` because the tsx CLI attempted to create its private IPC pipe.
No pipe/listener was created. Running the same verifier through `node --import tsx scripts/verify-migrations.ts` avoided
that reviewer-tool IPC path and successfully verified all 36 migrations and 119 tables.

These were disposable reviewer-harness corrections only and created no product uncertainty.

## Product, effect, and cleanup confirmation

The product remains effect-free and default-disabled. No application or product listener, SSH connection, credential
store, Hermes/provider, production PostgreSQL, deployment, DNS record, or remote network endpoint was contacted or
changed.

Both disposable product archives, all probe files, build output, and temporary database state were removed. Absence was
confirmed. The shared checkout remained clean on branch `codex/cr13a-live-070-private-loopback-framing` at
`51d8cc5c48d8f2ebd9dd878a415f011a0d30dffe`.

## Final disposition

`accepted`

Exact remediation `8e4c20da7166d48cb22c06fd38dfe87ee0016a02` closes M-001, M-002, L-001, and L-002
without a new High, Medium, or Low finding. This permits owner-controlled integration review only. It grants no listener,
connection, SSH, credential, native, provider, production, deployment, DNS, or network authority.
