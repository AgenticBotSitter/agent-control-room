# CR11B-AUTO-080 second-remediation independent re-review

**Disposition:** `REJECTED`

**Exact reviewed commit:** `b8287d75dca597196723e7705ba864ae153e48ac`

**Exact reviewed tree:** `b4abfd8f941f9b6f1f62e66a99529d26b362a387`

**Compared first-remediation-report-preservation parent:** `e44766b6024263abab2f35164099b574937118c6`

**Compared parent tree:** `e9d78b0557b397748e41081011ed73f4c730fc66`

**Review date:** 2026-08-30

**Reviewer:** third different independent Codex reviewer; not the implementation author, initial AUTO-080 reviewer, or
first-remediation reviewer

**Mode:** repository-only, effect-free, report-only independent re-review. No implementation, test, contract, status,
prior-report, dependency, Git-history, runtime-setup, provider, network, credential, protected-reference, database,
process, service, native-qualification, deployment, cleanup, or external-effect change.

**Initial immutable report SHA-256:**
`343da8c163bda9d437d3b850186a4a6b3623b9c255b9b9ab3eec5deaaf532f8c`

**First-remediation immutable report SHA-256:**
`bbe1a02b1f442c74f4f7e1e07ba038dcf620a2e3d43595c399a20f0427ec4421`

**This report SHA-256:** pending calculation after the final report write; supplied in the report-only handoff because
embedding the file's own digest would change that digest

## Decision

Exact second-remediation commit `b8287d75dca597196723e7705ba864ae153e48ac`, tree
`b4abfd8f941f9b6f1f62e66a99529d26b362a387`, is rejected.

The remediation closes both previously demonstrated raw-`Uint8Array` key exposures. Full-backing-buffer erasure no
longer calls ambient `fill`: it constructs a whole-buffer view through the captured constructor, performs indexed zero
writes, and verifies every byte through captured `Uint8Array.prototype.at`. Shared HMAC key-length validation no longer
uses mutable `instanceof Uint8Array` or `key.byteLength`; it uses captured Node host predicates and the captured typed
array byte-length getter. AUTO-080 also checks the captured global constructor, constructor prototype, prototype link,
own `fill`/`byteLength` shadows, inherited fill identity, and inherited byte-length getter before making a private key
copy. Existing hostile tests cover post-load global `Uint8Array`/`Symbol.hasInstance`, inherited `byteLength`, inherited
fill, and fill already replaced when a fresh host-value module evaluates. Those replacements execute zero times through
the repaired raw-key surfaces, and method-free overwrite erases the complete test backing buffers.

The complete private-key lifetime still contains a different mutable-runtime escape. `hmacSha256Tag` creates a native
HMAC object with the private request key and then performs ambient property lookup and invocation through
`createHmac(...).update(...).digest(...)`. Neither the shared helper nor the AUTO-080 runtime guard captures or verifies
the keyed object's `update` and `digest` behavior. A post-module-load replacement of the HMAC prototype's `update`
property with a getter or method receives the already-keyed HMAC object as its receiver. It can retain that object and
throw before native update or digest finalizes it. AUTO-080's `finally` then correctly wipes its `Uint8Array` copy, but it
cannot erase or revoke the separately retained native HMAC context. After the hostile property is restored, that retained
context is a one-use signing capability for attacker-selected material. Raw key bytes need not be exposed for request
integrity to be defeated.

This is `AUTO080-RR2-001`. It is a direct source-level post-load shared-runtime path over an object that already contains
the private key, not a demand for impossible proof of native provenance. The documented clean-module-initialization
assumption is clear and acceptable for capturing the initial Node and ECMAScript intrinsics; it does not authorize later
ambient dispatch on a keyed object. Because the candidate's threat tests and earlier reviews explicitly place post-load
global/prototype replacement in scope, this remaining keyed-capability escape requires rejection.

The request remains non-authorizing and statically effect-free. The finding does not select a provider, contact a
database or network, start a process, resolve a credential, authorize cleanup, activate production, dispatch work, or
create an external effect.

## Exact scope and lineage

Preflight confirmed branch `codex/cr11b-auto-080-disposable-hosted-qualification`, an empty porcelain status, exact
commit `b8287d75dca597196723e7705ba864ae153e48ac`, and exact tree
`b4abfd8f941f9b6f1f62e66a99529d26b362a387` before this report was created.

`git diff --name-status e44766b..b8287d75dca597196723e7705ba864ae153e48ac` showed nine declared second-remediation
paths:

- modified: `docs/BUILD_STATUS.md`, `docs/CONTROL_ROOM_COMPLETION_PROGRAM.md`,
  `docs/CR11B_AUTO_080_ACCEPTANCE.md`, `docs/CR11B_AUTO_080_DISPOSABLE_HOSTED_QUALIFICATION_CONTRACT.md`, and
  `docs/CR3_DECISION_LOG.md`;
- modified: `src/ready-frontier/v1/disposable-qualification.ts`, `src/security/digest.ts`, and
  `src/security/host-value.ts`; and
- modified: `tests/ready-frontier-disposable-qualification.test.ts`.

The initial AUTO-080 candidate remains rooted at accepted AUTO-070 parent `149961467041f9c7f1166e27cdc0407c5fd86462`.
The history preserves initial rejected candidate `85199ab146c8362a216dc9b2cdd3285efc3008b7`, initial report commit `a0929f1`,
first remediation `10eb807c8edd859261aa8dae09bcd5e116f42420`, first-remediation report commit `e44766b`, and this second
remediation in order. Both prior immutable reports retain their required SHA-256 values.

No package dependency, lockfile, migration, environment, service, provider, credential, protected reference, database,
process, network, cleanup, deployment, or operational-client path changed in the second-remediation range.

## Independently observed checks

| Command or review | Independent result |
|---|---|
| branch, status, commit, tree, parent-tree, and recent-history checks | Clean pre-report checkout on the expected branch; exact commit/tree and ordered rejection/remediation lineage confirmed |
| both prior report SHA-256 checks | `343da8c1...32f8c` and `bbe1a02b...c4421` confirmed unchanged |
| `git diff --name-status e44766b..b8287d` | Nine declared second-remediation source, test, contract, status, program, and decision paths only |
| `git diff --check e44766b..b8287d` | Exit 0; no whitespace errors |
| `node --import tsx --test tests/ready-frontier-disposable-qualification.test.ts` | 11/11 passed; zero failures, skips, or cancellations |
| `npm run test:cr11b` | 148/148 passed; zero failures, skips, or cancellations |
| `npm run pretest` | 730/730 passed; zero failures, skips, or cancellations |
| `npm run test --ignore-scripts` | 416 total; 414 passed, zero failed, two intentional platform skips |
| `npm run posttest` | 52/52 passed; zero failures, skips, or cancellations |
| `npm run check` | Exit 0; TypeScript no-emit check passed |
| `npm run lint` | Exit 0; full ESLint gate passed |
| `npm run build` | Exit 0; production build passed |
| `node --test tests/rendered-html.test.mjs` | 2/2 rendered-route checks passed |
| `node --import tsx scripts/verify-migrations.ts` | Exit 0; all 27 migrations applied and 97 PostgreSQL tables verified in the repository verifier |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; no readiness or native attempt |
| exact source/import review | No live provider, database, process, network, credential, protected-reference, cleanup, consumer, scheduler, dispatch, execution, or deployment client found |
| complete request-key lifetime review | Prior raw-key surfaces closed; rejection-level ambient dispatch remains on an already-keyed native HMAC object |

No custom probe was created or executed. The new finding follows directly from the exact shared HMAC source path and
JavaScript call/property-evaluation semantics. No runtime intrinsic or descriptor was changed by this reviewer.

## Recorded finding closure

### `AUTO080-IR-001` — raw copied backing-store cleanup is closed

The request builder and parser each call `assertDisposableRuntimeV1` before copying the request key and enclose every
subsequent path in `try`/`finally`. Both finally blocks call `wipeKeyV1`, which delegates to
`wipeHostUint8ArrayV1`. The shared wipe obtains the actual backing buffer through the captured typed-array buffer getter,
constructs a whole-buffer view through the captured `Uint8Array` constructor, writes zero to every indexed byte, and
checks every byte through captured `at` plus captured `Reflect.apply`.

The overwrite itself performs no ambient typed-array method lookup. The verification uses a captured intrinsic directly,
not a property obtained from the key or wipe view. It therefore does not depend on `fill`, including when fill was
already replaced before a freshly evaluated host-value helper captured its other intrinsics. The focused regression
demonstrates complete erasure for ordinary whole-buffer probes and zero hostile fill calls. For AUTO-080, private key
copies are new exact full-buffer `Uint8Array` values, so the helper erases the full private allocation on successful and
failing builder/parser paths after key creation.

Post-load inherited fill drift and own `Uint8Array.prototype.fill` shadowing are rejected before any AUTO-080 key copy.
The exact runtime guard also rejects constructor/prototype-link drift and an own byte-length shadow. None of those checks
invokes the hostile property value.

The exact ambient-fill retention mechanism in `AUTO080-IR-001` is closed.

### `AUTO080-RR1-001` — raw key exposure through HMAC binary metadata is closed

`hmacSha256Tag` now calls `hostUint8ArrayByteLengthV1`. That helper rejects Proxies through captured Node host behavior,
requires Node's captured `isUint8Array` host predicate, and applies the captured typed-array byte-length getter through
captured `Reflect.apply`. It never evaluates the current global `Uint8Array`, `Symbol.hasInstance`, `key.byteLength`, an
own key property, or the key's current prototype chain.

A post-load hostile global `Uint8Array`/`Symbol.hasInstance` replacement therefore receives no key. A post-load hostile
inherited byte-length getter likewise receives no key. Direct shared-HMAC tests continue producing the exact expected tag
while those ambient surfaces are changed; AUTO-080 separately fails closed at its pre-copy runtime guard with zero hostile
calls. Own shadow and captured-prototype drift are also rejected before AUTO-080 copies its key, while the shared HMAC
helper itself does not use those properties.

No caller-owned raw key copy can escape through either recorded binary-metadata surface. The specific
`AUTO080-RR1-001` reproduction is closed.

The broader complete-lifetime property remains open because the keyed native HMAC context can escape as a signing
capability through the finding below.

## `AUTO080-RR2-001` — ambient HMAC method dispatch can retain an unfinalized keyed signing capability

**Severity:** high within AUTO-080's request-integrity and private-key-custody boundary; no owner or external-effect
authority

The shared helper is:

```ts
return `hmac-sha256:${createHmac("sha256", key).update(canonicalJson(value), "utf8").digest("hex")}`;
```

The host byte-length validation before this line is behavior-free with respect to mutable JavaScript binary metadata.
The rest of the line is not. Evaluation first creates a native HMAC object configured with the private key and then
resolves `update` as an ambient property on that already-keyed receiver. The helper captures neither the HMAC prototype
nor the `update`/`digest` callables and does not apply a captured callable through a captured invocation primitive.

A post-load shared-runtime replacement can make `update` an accessor or method that:

1. receives the newly keyed HMAC receiver;
2. stores that receiver in caller-owned state; and
3. throws before native update or digest consumes/finalizes the context.

AUTO-080 catches the exception only through its surrounding `finally`. The new indexed wipe correctly zeros the private
`Uint8Array` backing buffer, but the retained native HMAC context is a different object with its own keyed state. After
the hostile HMAC property is restored, the retained context can be fed one attacker-selected canonical message and
digested to produce a valid tag. This is a one-use signing capability rather than a raw byte copy, but it defeats the same
request-authentication boundary and is outside the reach of `wipeKeyV1`.

Replacing `digest` can similarly execute caller behavior on the keyed receiver before finalization. Existing hostile
tests replace only global `Uint8Array`, inherited `byteLength`, and fill. They do not replace any HMAC-object property and
therefore cannot detect this escape. The AUTO-080 guard verifies only typed-array runtime identities; it has no HMAC
object/prototype check.

The direct lookup is also reached on both construction and parsing. Construction calls the helper for the new request
tag and then invokes parsing with the outer private key. Parsing calls it while verifying a supplied tag. A hostile HMAC
method can throw on correct or tampered input before the corresponding finally block, leaving the retained keyed context
while the visible `Uint8Array` copy is erased. The earlier fill and binary-metadata remediations do not revoke that
context.

### Required remediation boundary

No mutable JavaScript getter or method may receive an object after the private request key has been installed in it. The
HMAC path must avoid ambient `.update`/`.digest` lookup and invocation on keyed objects. It must use a clean-start captured
and validated native HMAC operation or captured HMAC callables invoked only through captured host operations, with no
caller behavior between creation, update, digest, and disposal. Material canonicalization should complete before a keyed
native context exists, or otherwise be proven unable to execute shared-runtime behavior while that context is live.

Hostile regression coverage must, after the security modules load:

1. replace HMAC `update` with both an accessor and a method that attempt to retain the receiver;
2. separately replace HMAC `digest` with behavior that attempts the same;
3. cover request construction and parsing, correct and tampered requests, and success and failure cleanup;
4. prove zero hostile calls and zero retained raw key or keyed HMAC capability;
5. preserve the existing global-constructor, inherited-byte-length, fill, own-shadow, and prototype-drift protections;
6. restore every changed runtime descriptor in `finally`; and
7. re-verify exact source lineage, substitution denial, chronology, replay, projection privacy, and negative authority.

This report does not prescribe a particular implementation. A new exact remediation commit requires another different
independent reviewer.

## Clean-module-initialization trust assumption

The candidate now states the trust boundary accurately: host predicates, ECMAScript intrinsics, Node crypto entry points,
and typed-array identities present when the security modules initialize are trusted. It does not claim that JavaScript
inside an already compromised process can prove those initial functions are native. That is an honest and acceptable
in-process assumption under the repository's same-process-compromise exclusion.

The finding does not challenge that assumption. It concerns a later property lookup on a keyed object after clean module
initialization. The repository already treats post-load global and prototype mutation as in-scope hostile behavior and
tests several such mutations. Clean initialization cannot make a later uncaptured property resolution immutable.

## Complete contract re-review

### Source lineage, signing, substitution, and replay

The request embeds the complete authenticated accepted AUTO-070 custody plan and successful no-fault report and re-runs
both accepted parsers. It requires `simulated_pass`, no injected fault, eight passes, zero failures, zero qualified
proofs, and all nine production proofs still outstanding. It pins accepted implementation commit
`20eeb148ce7ecf59a777f060eacd9245d9948cc8` and accepted independent-review SHA-256
`07033f542a7e3b7167a95d3fa301b90ff3806ec49232cddc878e8fa84353f681`.

Strict parsing, the full unsigned request digest, and the request HMAC reject ordinary wrong-key, changed-source,
re-digested, and re-signed substitution. The seven operations, ten blockers, and eight scenario codes are compared with
private fixed ordered literals. Exact replay remains deterministic in the accepted clean runtime. Those normal checks
pass, but a caller-retained HMAC signing capability can authenticate one attacker-selected request material and therefore
prevents acceptance of the complete integrity claim.

### Chronology

Timestamps remain canonical. Request issuance cannot precede successful fake-report completion; expiry must be strictly
after issuance, no later than the accepted AUTO-070 plan expiry, and no more than 3,600 seconds after issuance. The fixed
1,800-second future live-activity ceiling remains separate. Expiry does not grant cleanup authority.

### Exact input, accessor, Proxy, own-shadow, and prototype behavior

The request boundary rejects input Proxies through the Node host predicate before reflection and accepts only exact
ordinary enumerable data properties. Existing accessor and Proxy tests execute zero caller traps. Source plan/report
parsers re-establish their accepted exact-data and authentication properties.

AUTO-080's runtime guard reads descriptors through captured reflection. It checks current global `Uint8Array` identity,
its exact constructor-prototype data property, the exact captured prototype link, absence of own `fill` and `byteLength`,
and captured inherited fill and byte-length identities before any request-key copy. This statically closes the requested
own-shadow and typed-array prototype-drift cases without invoking their values. Shared HMAC byte-length validation remains
independent of all those mutable properties.

The new finding is a later ambient HMAC-object property lookup, not an accepted caller input or a typed-array metadata
lookup.

### Fixed envelope, projection, and privacy

The request fixes two new disposable non-production databases, three isolated worker roles, `SERIALIZABLE` transactions,
seven ordered operations, ten blockers, at most 40 provider calls, at most 1,800 seconds of future live activity, and at
most 1,048,576 bytes of sanitized retained evidence. Cleanup remains mandatory, separately authorized, and receipt-bound.
Production data, public endpoints, raw retained evidence, wildcard operations, arbitrary SQL/process commands, and
unbounded retry are forbidden.

Projection first authenticates the complete request, then emits only safe request, scope, and source-report identities;
resource classes; fixed operations and blockers; call and duration ceilings; cleanup requirement; and false capability
flags. It omits embedded source bodies, HMACs, protected-access mode, provider/resource identities, credentials,
connection details, hostnames, process output, raw evidence, and backup material. It is strict, digest-bound, and frozen.

The keyed-capability finding creates no ordinary projection-field disclosure. It affects repository request integrity.

### Negative authority and static absence of live effects

The request contains no owner signature, provider selection, disposable resource identity, protected access reference,
independent live service identities, checkpoint custodian, protected clock, terminal revocation feed, cleanup authority or
receipt, or independent live-result review. Every network, process, database, cleanup, live qualification, production
consumer/activation, approval, claim/lease, dispatch/execution, and external-effect field remains false.

Static source and import review found no PostgreSQL/provider client, socket, HTTP/TLS/DNS client, process launcher,
filesystem target, credential/protected-reference resolver, backup/restore/cleanup runner, scheduler, consumer,
dispatcher, executor, deployment client, or live-effect function. Package metadata only registers the focused test.

The exact effect-free preparation remains a useful non-authorizing artifact. This rejection grants no owner, provider,
credential, database, process, network, cleanup, production, dispatch, execution, or external-effect authority.

## No external activity

No external resource was accessed. This review did not contact GitHub, a provider, database, network, credential store,
native key store, protected reference, process, service, worker, deployment target, or cleanup target. It did not install
or download anything, change a runtime intrinsic, start a native qualification, provision or destroy a resource, perform
backup/restore/cleanup, commit, push, merge, or cause an external effect. The only filesystem change is this uncommitted
sanitized review report.

## Final disposition

Exact commit `b8287d75dca597196723e7705ba864ae153e48ac`, tree
`b4abfd8f941f9b6f1f62e66a99529d26b362a387`, is rejected for CR11B-AUTO-080. Preserve this report unchanged under its
handoff SHA-256. `AUTO080-IR-001` and the exact raw-key reproduction in `AUTO080-RR1-001` are closed, but complete private
key custody remains open under `AUTO080-RR2-001`. Remediate only in a new exact implementation commit and appoint another
different independent reviewer. No live qualification may begin while this finding remains open.

`REJECTED`
