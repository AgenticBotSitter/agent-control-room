# CR13A-LIVE-440 — Same-Module Source-Invocation and Raw-Handoff Implementation Design

**Status:** architecture remediation complete; dormant implementation blocked pending an accepted private attestation
pipeline; native execution remains separately owner-gated

**Accepted LIVE-420 product:** `c1287817079e6951ab5d1fbe24829cccc517687d`

**Accepted LIVE-420 review SHA-256:**
`6b472475d1e8d8bb9193b1b1df133316b8a939fbdec8c52e1e5b63bfd2308119`

**Accepted LIVE-430 product:** `a1c3230d4589ce72248038e722ccd4fd8600e9ee`

**Accepted LIVE-430 review SHA-256:**
`354e84ee68e1c1a202b738e0879070d6d449a268bbf001104eda4bdb246d0d0b`

**Required model:** `gpt-5.6-sol`

**Required reasoning effort:** `xhigh`

**Current effect boundary:** repository documentation only; no source-owner modification, source invocation,
descriptor/process/OS/host/path/environment read, raw observation, attestation, database activity, listener,
provider, network, runtime wiring, deployment, DNS, hosting, or production effect

## Purpose

LIVE-420 accepted the exact private spend/recheck/source-lookup flow and stopped before invocation. LIVE-430 accepted
the inert contract for one future synchronous source call and private raw custody. LIVE-440 fixes the exact code seam,
control-flow order, test separation, review packet, and terminal behavior for that future implementation before any
protected native value is read.

This design does not authorize or implement the call. A dormant repository implementation may be written and reviewed
without execution only after the private attestation pipeline below is independently accepted. The exact source path
may run later only under a fresh owner authorization bound to the immutable product and an authenticated result-
evidence chain. Repository implementation authority and native execution authority are separate.

## Exact insertion seam

The only permitted implementation location is
`src/connection-registry/v1/private-loopback-unreachable-atomic-native-observation-source.ts`, inside
`runPrivateAtomicSourceLookupCompositionV1`. The call is inserted after all of these have succeeded in the same lexical
flow:

1. exact LIVE-430 contract singleton verification;
2. exact sealed-authorization validation;
3. one accepted atomic authorization spend;
4. one immediate successful trusted-database-time recheck using the exact fresh receipt;
5. one captured private `WeakMap.get` using the module-owned implementation key; and
6. exact identity, frozen-state, and private-brand verification of the module-minted source.

The invocation must occur before any public result is constructed and before control leaves the inner `try` guarded
by the existing `finally`. The accepted existing direct-module factory may start the guarded flow for deterministic
tests and the later qualification harness. No external module may obtain or supply the source, raw record, intake,
callback, continuation, getter, test double, environment flag, runtime configuration, or caller-provided function.

## Fixed implementation order

The future exact code path must:

1. retain the accepted LIVE-420 spend, recheck, and lookup ordering unchanged;
2. verify the exact accepted LIVE-430 contract singleton before spend;
3. hold the private source in one lexical variable and invoke it exactly once with captured `Reflect.apply`, an
   `undefined` receiver, and the captured empty argument list;
4. assign the returned value directly to one lexical raw-observation variable without Promise assimilation,
   destructuring, spreading, serialization, hashing, logging, or intermediate publication;
5. validate exact frozen own-data shape using captured descriptor-safe primitives without invoking getters, Proxy
   traps, coercion, custom iterators, or ambient intrinsics;
6. require exactly `platform`, `architecture`, `release`, `uptimeSeconds`, `runtimeVersion`, `executablePath`,
   `processIdentifier`, and `parentProcessIdentifier`, with the exact validation domains below;
7. synchronously transfer the exact raw object reference to the first accepted private-intake stage declared in the
   same module, complete raw validation, lineage binding, and protected transformation before the first post-call
   `await`, and return only an exact private branded stage record containing no raw or reversibly transformed values;
8. immediately set the runner's source and raw-observation lexicals to `undefined` after successful synchronous intake
   and before the first post-call `await`; the intake must not retain the raw reference after its synchronous return;
9. complete the later signature, durable replay checkpoint, and independently protected high-water stages over exact
   private stage records, never the raw object, and preserve distinct stage results and failure states;
10. build a public terminal result only after the full accepted private pipeline has settled; and
11. set every application lexical holding the source, raw observation, spend receipt, recheck receipt, and private
    stage records to `undefined` in `finally` on every path as defense in depth for success and all failures.

The source invocation itself remains the only permitted operation that obtains the eight protected native values.
Validation may inspect the returned object's own descriptors but must not reread `node:process`, call `node:os`, or
reconstruct any property from another source.

The outer validator repeats the accepted source's value rules rather than treating source identity as sufficient:

- the record must be frozen, have exactly `Object.prototype`, have exactly the eight string-named own keys in the
  accepted order, and have no own symbols;
- each property descriptor must be a data descriptor with `writable: false`, `enumerable: true`, and
  `configurable: false`, with no getter or setter;
- platform, architecture, release, runtime version, and executable path must be strings whose captured trim is
  non-empty;
- uptime must be a finite number greater than or equal to zero;
- process identifier must be a safe integer greater than zero and parent process identifier a safe integer greater
  than or equal to zero; and
- no additional platform allowlist, path policy, string-length policy, coercion, normalization, or environment check
  is introduced in this stage. Later platform policy operates only on accepted attestation fields.

## Required prerequisite: private attestation pipeline

LIVE-440 dormant implementation must not begin merely because the invocation contract is accepted. Separate inert
contracts and independently reviewed implementations must first establish each non-collapsible stage below:

1. A private context-preparation stage obtains trusted database time, a fresh nonce, exact authorization/spend/recheck/
   source/candidate/attempt/contract lineage, and an approved signer identity before the source call. It exports none of
   those values and creates no invocation authority.
2. A synchronous same-module intake accepts only the exact raw object directly from the invocation lexical flow. It
   repeats exact validation, binds the prepared context, and transforms the raw record before the first post-call
   `await` into an exact private stage record containing only policy claims and domain-separated keyed commitments
   produced under accepted protected privacy-key custody. An unkeyed digest is forbidden. The intake may not retain
   the raw reference after it returns synchronously.
3. A distinct platform-signature stage signs the exact bound stage record using accepted protected key custody. It
   never returns a key, signer capability, raw value, or continuation.
4. A distinct durable replay-checkpoint stage records the signed attempt before any private success disposition.
5. A distinct independently protected high-water stage anchors the latest accepted checkpoint and rejects rollback,
   deletion, substitution, split commit, or uncertain settlement.
6. Later private candidate assembly, fresh owner authorization, physical qualification, independent qualification
   review, and runtime activation remain separate stages and receive no automatic authority.

Each stage has a separate exact branded private result and terminal failure state even when several execute
synchronously in one call stack. No later stage may substitute for, infer, or collapse an earlier stage. If any
contract, signer, checkpoint, high-water anchor, or private destination is absent or uncertain, the existing LIVE-420
flow continues to stop before invocation.

JavaScript cannot prove memory zeroization. The verifiable custody requirement is narrower: after synchronous intake,
no application-reachable raw reference remains in the runner or intake; no raw or reversible value reaches later
stage records, persistence, logs, errors, output, diagnostics, or artifacts; the disposable qualification process is
terminated; and a bounded residue scan finds no raw field values in retained evidence or files.

## Terminal outcomes and no retry

The future implementation may add only coarse sanitized outcomes that distinguish:

- rejection before spend;
- uncertain or known spent state before invocation;
- recheck failure;
- source lookup or identity failure;
- source invocation failure or uncertainty;
- raw observation validation failure;
- private attestation-intake failure or uncertainty; and
- signature, replay-checkpoint, or independent high-water failure or uncertainty, publicly collapsed only into
  `private_evidence_pipeline_failed_or_uncertain` while exact private stage failures remain distinct; and
- private handoff completed while every later authority remains false.

After a fresh spend commits, all failures are terminal spent outcomes. The code may not retry, replace authorization,
refund, unconsume, fall back, perform a second recheck, lookup, or invocation, infer whether a partial native read
occurred, resume after a crash, or return an object that a caller can use to continue. Ambiguity is failure, never
success.

`private_evidence_pipeline_failed_or_uncertain` is always terminal, spent, diagnostic-only, and non-accepting. It
cannot report private success, satisfy owner evidence, clear a blocker, or distinguish which protected stage failed.

## Public result and status boundary

Public evidence may include only implementation identity/digest, a coarse terminal outcome, fixed call counts, and
false authority/effect fields. It must never include or derive from the raw platform, architecture, release, uptime,
runtime version, executable path, process identifiers, descriptor data, source identity, authorization, receipts,
database time, nonce, signer material, candidate/attempt identity, protected key, error text, stack, or host path.

The dormant implementation's static and ordinary-test status remains zero native use. A later authenticated owner-run
qualification result may report one spend, one recheck, one lookup, one source invocation, eight native operations,
one raw record, one synchronous intake, distinct signature/checkpoint/high-water settlement, and the accepted private
disposition. It grants no approval, qualification, candidate, activation, network, command, lease, execution,
deployment, or production authority.

## Verification split

Ordinary deterministic verification must remain non-native. It may:

- inspect the exact product range and source text;
- run TypeScript, lint, build, render, migration, and all tests that provably stop before invocation;
- exercise pre-spend rejection, already-spent, expiry, database failure, commit uncertainty, mutation, and source-
  lookup failure paths with local PGlite;
- prove no injected source, raw input, callback, continuation, async boundary, second call, barrel export, runtime
  consumer, listener, provider, network, production database, or deployment path exists; and
- prove public schemas, terminal counts, freezing, hostile-input rejection, and sanitization without calling the
  source;
- exercise a non-authorizing deterministic state-machine seam that accepts only a fixed scenario enum, mints safe
  synthetic raw records and exact private stage records inside the owning module, and injects fixed source/validation/
  intake/signature/checkpoint/high-water fault outcomes without accepting a source, raw object, callback, signer, or
  dependency from the caller.

The same private validation and stage-transition functions must serve the production path and the deterministic seam;
static tests must prove the production runner can reference only the exact real source and the deterministic seam can
reference only its module-minted safe synthetic record. The seam is direct-module only, absent from every barrel and
runtime consumer, and returns sanitized non-authorizing results. No always-on unit, build, render, migration, CI,
worker, scheduler, or startup test may traverse the real source-invocation path. Injecting or substituting any source
or raw record into the production runner remains prohibited.

The dormant implementation may be accepted for ordinary integration using only the non-native producer and
independent review gates. That acceptance explicitly does not claim that the native happy path ran or works on a real
host.

Only after the full private attestation pipeline and authenticated evidence envelope are independently accepted may a
fresh owner packet authorize one owner-attended disposable Mac run against the exact frozen implementation product. It
uses a temporary local PGlite database and fresh one-use sealed authorization; performs at most one product attempt,
one source call, and eight protected native operations; permits no provider, MCP, plugin, Hermes, listener, network,
production database, deployment, or runtime effect; and performs exact cleanup. Uncertainty or failure ends the
attempt with no retry and cannot accept or activate the product.

## Independent review and acceptance order

Dormant implementation acceptance must preserve three immutable identities:

1. architecture commit;
2. exact implementation product and tree;
3. a different independent report-only zero-repair review of the exact product and non-native verification evidence.

The independent reviewer reruns the fixed non-native command sequence in a fresh disposable clone and confirms zero
native attempt or raw host value. Any product drift, unexpected invocation, test failure, or finding rejects dormant
integration.

The later native qualification must additionally preserve a single-use owner authorization and an authenticated
attempt/result envelope signed through the accepted signer, durable checkpoint, and independent high-water chain. The
envelope binds the exact product/tree, architecture, authorization digest, attempt identity, trusted start/end time,
fixed counts, terminal disposition, cleanup result, and prior envelope digest. A plain file digest is only an integrity
check and can never authenticate who ran the product or accept native evidence. A different reviewer verifies exact
signature/checkpoint/high-water continuity, owner-window consumption, bounded residue-scan evidence, and cleanup
without repeating the attempt. Missing or uncertain authentication makes the run diagnostic-only and non-accepting.

## Prohibited in the architecture-only LIVE-440 block

This block must not modify the source-owning module; add an invocation or raw-observation path; inspect descriptors;
read process, OS, host, path, environment, time, credentials, or protected values; create an attestation, nonce,
signature, checkpoint, candidate, authorization, listener, or physical attempt; run local PGlite; add a migration;
wire application, API, worker, scheduler, Idea Lab, Hermes, startup, or production use; contact a provider or
production PostgreSQL/VPS; open a network path; deploy; change DNS/Cloudflare/hosting; or clear an execution blocker.

## Acceptance for this design block

Architecture acceptance requires exact LIVE-420/LIVE-430 product and review binding; one explicit source-owner seam;
fixed invocation, exact descriptor/value validation, synchronous raw-transfer, distinct signature/checkpoint/high-water,
application-reference release, terminal-outcome, deterministic-seam, authenticated-evidence, qualification, cleanup,
and independent-review rules; explicit downstream private-pipeline prerequisite; and zero source-owner change, source
call, native read, raw observation, database activity, runtime consumer, or external effect.

Acceptance freezes the implementation plan only. It does not authorize implementation, native qualification, raw
observation handling, attestation, signing, replay persistence, candidate assembly, owner approval, physical
qualification, runtime activation, provider/production contact, deployment, hosting, or DNS.

## Reevaluate

Reevaluate after every private attestation pipeline stage is independently accepted and before writing the dormant
source-owner implementation. Reevaluate again under a fresh exact-product owner packet before running any real source-
invocation path, reading protected native material, producing authenticated owner evidence, or creating a native-
qualification review packet.
