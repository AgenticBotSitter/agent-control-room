# CR11B-AUTO-080 independent review

**Disposition:** `REJECTED`

**Exact reviewed commit:** `85199ab146c8362a216dc9b2cdd3285efc3008b7`

**Exact reviewed tree:** `99bc9a386b234c7bb937a53d5074f2315d0b2b15`

**Compared accepted AUTO-070 parent:** `149961467041f9c7f1166e27cdc0407c5fd86462`

**Accepted-parent tree:** `9292f23d6c6d0c31f98b763eb94c86522a2bd2c8`

**Review date:** 2026-08-30

**Reviewer:** independent Codex reviewer; not the implementation author or an AUTO-070 reviewer

**Mode:** repository-only, effect-free, report-only independent review. No implementation, test, contract, status,
package, Git-history, dependency, or runtime-setup change; no custom probe; no provider, database, process, worker,
network, credential, protected-reference, native qualification, deployment, or external effect.

**Report SHA-256:** pending calculation after this report is written; supplied in the report-only handoff because
embedding the file's own digest would change that digest

## Decision

Exact candidate commit `85199ab146c8362a216dc9b2cdd3285efc3008b7`, tree
`99bc9a386b234c7bb937a53d5074f2315d0b2b15`, is rejected.

The candidate normally re-verifies the complete authenticated successful no-fault AUTO-070 plan/report, pins the exact
accepted implementation and review identities, binds the fixed source, operations, blockers, ceilings, chronology, and
negative-authority fields into a request digest and HMAC, and emits a bounded safe projection. The focused and combined
tests, type check, lint, stage zero, and exact-range whitespace gate all pass. Static import review found no live
provider, PostgreSQL, process, network, credential, protected-reference, cleanup, consumer, dispatch, execution, or
deployment path.

However, the new authoritative request builder and parser erase their private copied request HMAC key through the
ambient property lookup `requestKey.fill(0)` in their `finally` blocks. `requestKey` is an ordinary `Uint8Array`, so a
post-module-load replacement of `Uint8Array.prototype.fill` executes caller-controlled shared-runtime behavior at this
security boundary. The replacement can retain `this`, preserving the internal copied request key instead of wiping it.
It can also run after accepted-source validation but before the outer operation returns. The AUTO-080 module neither
captures a trusted wipe intrinsic for these calls nor verifies the typed-array fill descriptor before use.

This violates the required mutable-runtime and no-caller-behavior boundary and defeats the claimed private key cleanup.
It is a concrete source-level issue, so the contract requires rejection even though the request remains non-authorizing
and contains no direct live-effect client.

## Exact scope and changed paths

Preflight confirmed branch `codex/cr11b-auto-080-disposable-hosted-qualification`, the requested exact commit and tree,
the accepted AUTO-070 parent and parent tree, and an empty porcelain status before this report was created. The exact
range contains one commit and ten declared paths:

- modified: `docs/BUILD_STATUS.md`, `docs/CONTROL_ROOM_COMPLETION_PROGRAM.md`, `docs/CR3_DECISION_LOG.md`, `package.json`,
  and `src/ready-frontier/v1/index.ts`;
- added: `docs/CR11B_AUTO_080_ACCEPTANCE.md`,
  `docs/CR11B_AUTO_080_DISPOSABLE_HOSTED_QUALIFICATION_CONTRACT.md`,
  `src/ready-frontier/v1/disposable-qualification-types.ts`,
  `src/ready-frontier/v1/disposable-qualification.ts`, and
  `tests/ready-frontier-disposable-qualification.test.ts`.

The accepted AUTO-070 implementation source is unchanged between accepted implementation commit
`20eeb148ce7ecf59a777f060eacd9245d9948cc8` and the compared parent. That intervening range contains only the accepted
AUTO-070 report and matching status, contract, program, acceptance, and decision-history updates.

No migration, lockfile, dependency version, environment, deployment, service, credential, provider, database, process,
network, or operational-client path was added.

## Independently observed checks

| Command or review | Independent result |
|---|---|
| `git status --short`, `git branch --show-current`, `git rev-parse HEAD`, and `git rev-parse HEAD^{tree}` | Clean pre-report checkout on the expected branch; exact commit `85199ab...` and tree `99bc9a3...` confirmed |
| `git rev-parse 149961467041f9c7f1166e27cdc0407c5fd86462^{tree}` | Accepted-parent tree `9292f23d6c6d0c31f98b763eb94c86522a2bd2c8` confirmed |
| `git log` and `git diff --name-status 1499614..85199ab` | One candidate commit; ten declared AUTO-080 source, test, contract, status, decision, export, and test-registration paths |
| `git diff --name-status 20eeb14..1499614` | Accepted AUTO-070 source unchanged; only acceptance/report/history documentation differs |
| `git diff --check 1499614..85199ab` | Exit 0; no whitespace errors |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; no readiness or native attempt |
| `node --import tsx --test tests/ready-frontier-disposable-qualification.test.ts` | 9/9 passed; zero failures, skips, or cancellations |
| `npm run test:cr11b` | 146/146 passed; zero failures, skips, or cancellations |
| `npm run check` | Exit 0; TypeScript no-emit check passed |
| `npm run lint` | Exit 0; full ESLint gate passed |
| Exact source, import, and package-diff review | No direct live provider, database, process, network, credential, protected-reference, cleanup, consumer, scheduler, dispatch, execution, deployment, or external-contact path found |
| Mutable-runtime source review | Rejection-level ambient `Uint8Array.prototype.fill` key-erasure seam at both AUTO-080 request-key `finally` paths |

No custom probe was created or executed. No external GitHub state was queried because the review packet forbids external
contact; recent commits, branch state, and existing local refs were inspected only as repository evidence.

## Contract reconstruction

### Source chain and authenticated identity

The request embeds the complete plan and report rather than digest-only aliases. Parsing re-runs the accepted AUTO-070
plan and report parsers with the activation-packet and qualification integrity keys, requires `simulated_pass`, no
injected fault, exactly eight passes and zero failures, zero qualified proofs, and all nine remaining blockers. It then
requires exact tenant, workspace, plan/report IDs and digests. The request material pins accepted AUTO-070 implementation
commit `20eeb148ce7ecf59a777f060eacd9245d9948cc8` and accepted review SHA-256
`07033f542a7e3b7167a95d3fa301b90ff3806ec49232cddc878e8fa84353f681`.

Ordinary wrong-key, changed-source, re-digested, and re-signed substitutions fail in the existing gate. The request digest
covers the complete accepted source and fixed request material; the request HMAC separately binds request identity,
scope, source digests, and chronology. These normal source-chain checks are coherent but cannot outweigh the private-key
lifetime defect below.

### Fixed operations, blockers, ceilings, and negative authority

Construction fixes the exact ordered seven operations, exact ordered ten blockers, two databases, three processes,
`SERIALIZABLE` isolation, at most 40 provider calls, at most 1,800 seconds of live activity, and at most 1,048,576 bytes
of sanitized retained evidence. Parsing compares the operation, blocker, and eight-scenario arrays to private fixed
literals, while strict schemas require every ceiling and resource count as a literal.

Cleanup remains mandatory, separately authorized, and receipt-bound. Production data, public endpoints, raw evidence,
provider/resource selection, protected references, owner authorization/signature, network, process start, database
contact, cleanup, live qualification, production consumption/activation, approval, claim/lease, dispatch/execution, and
external-effect authority are all fixed false. No wildcard operation, arbitrary SQL, arbitrary process command, retry
surface, or live runner is exposed.

### Chronology and replay

Canonical timestamps are required. Issuance must be at or after the accepted fake report completion, expiry must be
strictly after issuance, expiry cannot exceed the accepted AUTO-070 plan expiry, and the request window cannot exceed
3,600 seconds. These constraints also imply that issuance precedes plan expiry. The 1,800-second live-activity ceiling is
fixed separately from the request window.

Under an unmodified runtime, exact replay re-parses to the same digest/HMAC-bound request and changed replay fails closed.
The chronology comparisons and source parsers use captured Date operations. The rejection is not a normal chronology or
replay mismatch; it is the ambient key-wipe callback and key-retention seam reached during both construction and parsing.

### Exact input, accessor, and Proxy boundary

The shared exact snapshot rejects host-detected Proxies before reflection and accepts only ordinary enumerable data
properties, so the existing outer and nested accessor/Proxy tests execute zero caller traps. Private parser closures and
strict schemas reject added fields, including provider or credential material.

Those checks cover caller-supplied values, not mutable process-global prototypes. The new module later performs a direct
method lookup on its internal `Uint8Array` key copy. A changed `Uint8Array.prototype.fill` is therefore executed by the
trusted path even though no input accessor or Proxy is accepted.

### Safe projection and privacy

Projection first authenticates the complete request, then emits only safe request/scope/report identities, provider and
resource classes, the seven fixed operations, ten fixed blockers, call and duration ceilings, cleanup requirement, and
false capability flags. It omits embedded source plan/report bodies, request HMAC, protected-access mode, evidence
material, credentials, provider/resource identities, connection details, hostnames, process output, and backup material.
The result is strict, digest-bound, and recursively frozen under the ordinary runtime.

The source-level key-wipe defect does not add fields to this public projection. Its impact is integrity-key custody and
unexpected shared-runtime execution, not an ordinary projection-field disclosure.

### Absence of a live-effect path

AUTO-080 imports only Node crypto, Zod, repository security helpers, the accepted AUTO-070 parsers, exact-value helpers,
errors, and local constants/types. It contains no PostgreSQL/provider client, socket or HTTP/TLS/DNS client, process
launcher, filesystem path, credential/protected-reference resolver, scheduler, consumer, dispatcher, executor,
deployment client, or cleanup runner. Package metadata only registers the new focused test.

The static absence of a live-effect path is accepted as a narrow negative fact. It does not make the request-integrity
implementation acceptable while the mutable-runtime key-custody issue remains.

## `AUTO080-IR-001` — ambient typed-array fill executes caller behavior and can retain the request HMAC key

**Severity:** high within AUTO-080's request-integrity and private-key-cleanup boundary; no owner or external-effect
authority

`key()` safely rejects non-exact host bytes and creates a private copy. Both exported request operations then attempt to
erase that copy with `requestKey.fill(0)` in `finally`. Because the property is resolved at call time from
`Uint8Array.prototype`, a post-load replacement controls the cleanup call. A replacement can capture the method receiver,
leave its bytes unchanged, and execute arbitrary synchronous shared-runtime changes. Source validation does not make
this safe: accepted AUTO-070 parsing happens earlier in the same operation, and AUTO-080 performs the ambient wipe after
that validation.

The candidate already imports a hardened exact-host-byte helper whose returned capability wipes through captured native
intrinsics, but AUTO-080 discards that capability after copying and uses the ambient typed-array method instead. The
focused suite mutates ordinary input accessors and Proxies but does not replace the typed-array fill method, so all 9/9
focused and 146/146 combined cases pass without exercising this path.

### Required remediation boundary

Every private key copy must be erased through a captured, validated host intrinsic or an equivalent private wipe
capability that performs no ambient property lookup and cannot execute caller behavior. Construction, parsing, failure,
and success paths must all wipe the complete copied backing store. Hostile regression coverage must replace the relevant
typed-array method only after module load, prove that the replacement executes zero times, prove the internal copy is
actually erased, restore the runtime, and re-verify unchanged source, request, replay, projection, and negative-authority
truth.

This report does not prescribe a specific implementation. A new exact remediation commit requires a different
independent reviewer. No live qualification may begin while this finding is open.

## Residual risks and explicit negative authority

The finding does not transform the repository HMAC into an owner signature and does not create a provider, resource,
credential, protected reference, live database, process, network call, backup, restore, cleanup, deployment, consumer,
dispatch, execution, or external effect. Every request and projection authority flag remains false, and the accepted
AUTO-070 fake remains non-production evidence with all nine production gates blocking.

No owner signature, provider or disposable resource, protected access reference, independent service identities,
external checkpoint custodian, protected commit clock, terminal revocation feed, cleanup authority/receipt, or
independent result review exists in this repository candidate. A later live attempt still requires a new exact
owner-authorized packet, separately supplied protected resources, bounded effect ledger, sanitized evidence, verified
cleanup, and independent result review. This rejection grants none of that authority.

No external resource was accessed. The review did not install or download anything, contact GitHub or a provider, read a
credential or protected reference, start a process or service, contact a database or network, create or destroy a
resource, perform backup/restore/cleanup, simulate an owner signature, run a native qualification, commit, push, merge, or
cause an external effect. The only filesystem change is this uncommitted review report.

## Final disposition

Exact commit `85199ab146c8362a216dc9b2cdd3285efc3008b7` and tree
`99bc9a386b234c7bb937a53d5074f2315d0b2b15` are rejected for CR11B-AUTO-080. Preserve this report unchanged under its
handoff SHA-256. Remediate only in a new exact implementation commit and appoint a different independent reviewer.

`REJECTED`
