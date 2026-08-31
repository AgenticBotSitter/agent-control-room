# CR11B-AUTO-080 third-remediation independent re-review

**Disposition:** `ACCEPTED`

**Exact reviewed commit:** `091ff116c8735aa980608c9c5c0b468436537cae`

**Exact reviewed tree:** `0153f5d2b794eaa05d30c88add8398d2c5ec2898`

**Compared second-report preservation parent:** `3694b5943f0b01b29ba2f6a11756a71f55ede59a`

**Compared parent tree:** `a70d830c9a93fc54d194b125e84635efce096ec4`

**Review date:** 2026-08-30

**Reviewer:** fourth different independent Codex reviewer; not the implementation author or any prior AUTO-080 reviewer

**Mode:** repository-only, effect-free, report-only independent re-review. No implementation, test, contract, status,
prior-report, dependency, history, provider, database, process, network, credential, protected-reference, cleanup,
deployment, native-qualification, or external-effect change.

**Prior immutable report SHA-256 values:**

- initial review: `343da8c163bda9d437d3b850186a4a6b3623b9c255b9b9ab3eec5deaaf532f8c`;
- first-remediation re-review: `bbe1a02b1f442c74f4f7e1e07ba038dcf620a2e3d43595c399a20f0427ec4421`; and
- second-remediation re-review: `c105ed8ef640ca4cd4aeb0c5f548d57e4ec5f9f3a9b3144c800dfb3f0c92f239`.

**This report SHA-256:** pending calculation after the final report write; supplied in the report-only handoff because
embedding the file's own digest would change that digest.

## Decision

Exact third-remediation commit `091ff116c8735aa980608c9c5c0b468436537cae`, tree
`0153f5d2b794eaa05d30c88add8398d2c5ec2898`, is accepted for the effect-free CR11B-AUTO-080 preparation boundary.

The complete private request-key and keyed-HMAC lifetime was re-reviewed. The earlier ambient fill, mutable binary
metadata, and keyed-object method-dispatch mechanisms are closed. The third remediation canonicalizes the complete HMAC
material before a keyed context exists, captures the clean-initialization HMAC prototype and its exact `update` and
`digest` data callables, validates both descriptors before AUTO-080 copies the request key, and invokes both captured
callables only through captured `Reflect.apply`. No post-load JavaScript property lookup occurs on the keyed HMAC object.

The hostile registered gate replaces each HMAC operation after module load with both an accessor and a method. Direct
shared-HMAC use, request construction, correct parsing, and tampered parsing all fail before the hostile behavior can
run; the hostile replacements receive zero calls and retain neither raw key bytes nor a keyed signing capability.
Descriptor restoration is followed by successful exact replay, expected tamper rejection, safe projection, and unchanged
negative-authority truth. Existing regressions also preserve the global-constructor, inherited-byte-length, fill-before-
and-after-helper-load, own-shadow, and prototype-identity protections.

The exact source chain, HMAC and digest binding, substitution and re-signing denial, chronology, exact input boundary,
accessor/Proxy behavior, projection privacy, and live-effect absence remain coherent. No new evidence-backed repository
finding was identified.

## Exact scope and lineage

Preflight confirmed an empty porcelain status, branch
`codex/cr11b-auto-080-disposable-hosted-qualification`, exact reviewed commit and tree, and the exact report-preservation
parent and tree. The third-remediation range changes eight declared paths:

- `src/security/digest.ts` captures and validates the HMAC finalization operations;
- `src/ready-frontier/v1/disposable-qualification.ts` requires the captured HMAC runtime before private key copy;
- `tests/ready-frontier-disposable-qualification.test.ts` adds the hostile four-form HMAC regression; and
- five acceptance, contract, program, status, and decision-history documents record the remediation and required review.

The range adds no dependency, migration, provider adapter, network client, database client, process launcher, credential
resolver, cleanup runner, deployment surface, or operational configuration. All three prior negative reports retain their
required exact SHA-256 values.

The request still embeds and re-verifies the complete accepted successful no-fault AUTO-070 plan and report. It pins
accepted implementation commit `20eeb148ce7ecf59a777f060eacd9245d9948cc8` and accepted independent-review SHA-256
`07033f542a7e3b7167a95d3fa301b90ff3806ec49232cddc878e8fa84353f681`. It accepts only `simulated_pass`, no injected
fault, eight simulated passes, zero simulated failures, zero qualified production proofs, and all nine production proofs
still outstanding.

## Independently observed checks

| Command or review | Independent result |
|---|---|
| branch, status, commit, tree, parent, and recent-history checks | Clean pre-report checkout on the expected branch; exact commit `091ff116...`, tree `0153f5d...`, parent `3694b594...`, and parent tree `a70d830...` confirmed |
| prior-report SHA-256 verification | Exact required values `343da8c1...32f8c`, `bbe1a02b...c4421`, and `c105ed8e...2f239` confirmed |
| `git diff --name-status 3694b59..091ff11` | Eight declared source, test, acceptance, contract, status, program, and decision paths only |
| `git diff --check 3694b59..091ff11` | Exit 0; no whitespace errors |
| focused AUTO-080 test | 12/12 passed; zero failures, skips, or cancellations |
| combined CR11B test | 149/149 passed; zero failures, skips, or cancellations |
| registered pretest | 731/731 passed; zero failures, skips, or cancellations |
| core test | 416 total; 414 passed, zero failed, two intentional platform skips |
| public post-test | 52/52 passed; zero failures, skips, or cancellations |
| TypeScript and full lint | Both exit 0 |
| production build and rendered HTML | Build passed; 2/2 route tests passed |
| migration verifier | All 27 migrations applied; 97 PostgreSQL tables verified in the isolated verifier |
| macOS stage zero | Exit 0; `ready_for_runtime_check`; no readiness or native attempt |
| exact source and import review | No live provider, network, database, process, credential, protected-reference, cleanup, scheduler, consumer, dispatch, execution, or deployment path found |

No custom probe was created or executed. No external GitHub state, network, credential, provider, database, native service,
or process was contacted.

## Finding closure

### `AUTO080-IR-001` — closed

AUTO-080 no longer performs ambient `requestKey.fill(0)`. Both private copied request keys are erased in `finally`
through `wipeHostUint8ArrayV1`, which reaches and overwrites the complete backing buffer through clean-start captured host
intrinsics and verifies the zeroed bytes through the captured typed-array `at` operation. Post-load inherited fill drift
is rejected before key copy, while the wipe helper itself does not dispatch through fill. The helper remains effective
even when fill was already replaced before a fresh helper module is loaded. Success and failure paths use the same
unconditional cleanup.

### `AUTO080-RR1-001` — closed

HMAC key-length validation uses captured Node host predicates and the captured `%TypedArray%` byte-length getter. It does
not evaluate `key instanceof Uint8Array`, `key.byteLength`, or another ambient key property. AUTO-080 validates the exact
global constructor, constructor-prototype data property, captured prototype link, inherited fill identity, inherited
byte-length getter, and absence of own `fill`/`byteLength` shadows before making a private copy. The existing hostile
global `Uint8Array`/`Symbol.hasInstance` and inherited getter substitutions receive zero key-bearing calls, including for
correct, tampered, construction, and parsing paths. No caller-owned raw-key copy escapes.

### `AUTO080-RR2-001` — closed

`hmacSha256Tag` now completes canonical material construction before native HMAC creation. At clean module initialization
it captures the HMAC prototype, exact own data descriptors for `update` and `digest`, both callables, the descriptor and
prototype readers, and `Reflect.apply`. It validates both current method identities before creating a keyed context, then
applies the captured operations directly to the native receiver. Source inspection confirms there is no chained
`createHmac(...).update(...)` and no ambient `hmac.update(...)` or `hmac.digest(...)` call.

Post-load replacement of either prototype operation with an accessor or method fails at descriptor validation before
keyed-object creation. AUTO-080 performs the same HMAC runtime validation before copying its request key. There is no
JavaScript callback between the final descriptor check, captured `createHmac` invocation, captured update call, and
captured digest call. Own shadows on a returned native context cannot be observed because no property is read from that
context, and prototype-chain drift outside the two captured own native operations cannot redirect either invocation.
The registered four-form attack receives zero calls and retains no context on direct HMAC, build, correct-parse, or
tampered-parse paths. The visible key copy is erased in the surrounding `finally` on every completion or throw.

## Complete contract re-review

The full unsigned request digest covers the embedded accepted source and fixed request material. The request HMAC binds
request identity, tenant/workspace scope, both source digests, and the exact issue/expiry window. Wrong keys, source
substitution, re-digestion, and re-signing against inconsistent embedded source fail closed. Exact replay is deterministic.

Canonical issuance cannot precede accepted report completion. Expiry must be strictly later than issuance, cannot exceed
the accepted plan expiry, and cannot exceed the one-hour request-lifetime ceiling. The separate future activity ceiling
remains 1,800 seconds and grants no authority.

Input Proxies are host-detected before reflection and exact snapshots accept only ordinary data properties. Accessors and
Proxy traps in the registered request attacks execute zero times. HMAC material used by AUTO-080 is an internally
constructed ordinary-data record; canonicalization completes before a native keyed context exists. The clean-module-
initialization scope is accurate: the boundary trusts the host predicates, ECMAScript intrinsics, Node crypto entry
points, and typed-array/HMAC identities present when security modules initialize. It does not claim to recover security
from JavaScript that compromised those initial values before module evaluation. Post-load mutable surfaces used by this
path are either descriptor-checked or bypassed through captured operations.

The safe projection authenticates the complete request and emits only bounded identifiers, resource classes, seven
fixed operations, ten fixed blockers, call/duration ceilings, cleanup requirement, and false capability flags. It omits
embedded source bodies, HMAC tags, protected-access mode, credentials, provider/resource identities, connection details,
hostnames, process output, backup material, and raw evidence.

## Negative authority and residual gates

The accepted repository artifact is only an effect-free request for future separately authorized work. It fixes two new
disposable non-production databases, three isolated workers, seven ordered operations, ten blockers, serializable
transactions, at most 40 provider calls, at most 1,800 seconds, and at most 1,048,576 sanitized evidence bytes. Cleanup
is mandatory, separately authorized, and receipt-bound. Production data, public endpoints, and raw evidence retention
remain forbidden.

No owner signature, provider selection, disposable resource identity, protected credential reference, independent live
service identity, external checkpoint custodian, protected clock, revocation feed, cleanup authority/receipt, or
independent live result exists in this candidate. Every network, process, database, cleanup, live qualification,
production consumer/activation, approval, claim/lease, dispatch/execution, and external-effect capability remains false.

Acceptance grants no authority to select a provider, resolve a credential, contact a database or network, start a
process, create or destroy resources, perform backup/restore/cleanup, run a native qualification, dispatch work, deploy,
or activate production. Any live disposable qualification still requires a new exact owner-authorized controlled-effect
packet, separately supplied protected resources, bounded protected execution, sanitized evidence, exact cleanup and
absence receipt, and another independent result review.

## No external activity

This review did not install or download anything, contact GitHub or a provider, access a credential or protected
reference, start a native readiness or qualification attempt, launch a service, contact a database or network, create or
destroy a resource, perform backup/restore/cleanup, commit, push, merge, or cause an external effect. The only filesystem
change is this uncommitted sanitized review report.

## Final disposition

Exact commit `091ff116c8735aa980608c9c5c0b468436537cae`, tree
`0153f5d2b794eaa05d30c88add8398d2c5ec2898`, is accepted for CR11B-AUTO-080's effect-free preparation boundary.
`AUTO080-IR-001`, `AUTO080-RR1-001`, and `AUTO080-RR2-001` are closed. No new repository finding was identified. This
acceptance does not authorize a live attempt or any external effect.

`ACCEPTED`
