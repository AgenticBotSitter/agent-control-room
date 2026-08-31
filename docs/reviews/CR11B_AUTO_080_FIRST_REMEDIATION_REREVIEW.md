# CR11B-AUTO-080 first-remediation independent re-review

**Disposition:** `REJECTED`

**Exact reviewed commit:** `10eb807c8edd859261aa8dae09bcd5e116f42420`

**Exact reviewed tree:** `a7b764ea434ff9fd93db5e16cc4d162da7bf1092`

**Compared report-preservation parent:** `a0929f1e2e4d91d805c10bdc701261b35888d045`

**Review date:** 2026-08-30

**Reviewer:** different independent Codex reviewer; not the implementation author or the initial AUTO-080 reviewer

**Mode:** repository-only, effect-free, report-only independent re-review. No implementation, test, contract, status,
prior-report, Git-history, dependency, runtime-setup, database, process, worker, network, credential, provider,
deployment, or external-effect change.

**Initial immutable report SHA-256:**
`343da8c163bda9d437d3b850186a4a6b3623b9c255b9b9ab3eec5deaaf532f8c`

**This report SHA-256:** pending calculation after the final report write; supplied in the report-only handoff because
embedding the file's own digest would change that digest

## Decision

Exact first-remediation commit `10eb807c8edd859261aa8dae09bcd5e116f42420`, tree
`a7b764ea434ff9fd93db5e16cc4d162da7bf1092`, is rejected.

The remediation closes the exact ambient-fill reproduction in `AUTO080-IR-001`. The request builder and parser no
longer invoke `requestKey.fill(0)`. Each exported AUTO-080 operation checks the captured inherited fill descriptor and
rejects an own `Uint8Array.prototype.fill` shadow. Both request-key copies are erased through
`wipeHostUint8ArrayV1`, which obtains the actual buffer and invokes the captured fill intrinsic rather than a property
on the key. The new existing regression replaces the inherited fill only after module load, proves zero hostile fill
calls and no retained receiver, demonstrates full-buffer erasure through the captured wipe helper, restores the
descriptor, and re-verifies request replay, projection, and negative authority. It passes.

The complete private-key boundary is nevertheless still unsafe. Both request operations pass the private copied key to
the shared `hmacSha256Tag` helper. That helper validates the key with the current mutable expressions
`key instanceof Uint8Array` and `key.byteLength`. The candidate's runtime guard checks only the fill descriptors; it
does not capture or verify the global `Uint8Array` binding, the `%TypedArray%.prototype.byteLength` getter, or an
equivalent behavior-free HMAC key capability.

The global `Uint8Array` data property is writable and configurable on this accepted host, and the inherited
`byteLength` accessor is configurable. A post-module-load replacement can therefore receive the private key as the
left-hand value of a hostile `Symbol.hasInstance`, or receive it as `this` in a hostile inherited `byteLength` getter.
It can synchronously copy the bytes and return an accepting result, allowing HMAC construction to continue. The
`finally` block then wipes only Control Room's original copy; it cannot erase the caller-owned copy already made by the
replacement. This is a direct source-level execution and key-retention path before cleanup, not a hypothetical failure
of the now-captured fill operation.

This is `AUTO080-RR1-001`. It leaves the broader private-key-cleanup requirement from `AUTO080-IR-001` open. It does not
create owner authorization or a live provider path, but a request-integrity boundary that can execute mutable shared
runtime behavior with its private key cannot be accepted.

## Exact scope and changed paths

Preflight confirmed an empty porcelain status, branch
`codex/cr11b-auto-080-disposable-hosted-qualification`, exact commit
`10eb807c8edd859261aa8dae09bcd5e116f42420`, and exact tree
`a7b764ea434ff9fd93db5e16cc4d162da7bf1092` before this report was created.

`git diff --name-status a0929f1e2e4d91d805c10bdc701261b35888d045..10eb807c8edd859261aa8dae09bcd5e116f42420`
showed seven declared remediation paths:

- modified: `docs/BUILD_STATUS.md`, `docs/CONTROL_ROOM_COMPLETION_PROGRAM.md`,
  `docs/CR11B_AUTO_080_ACCEPTANCE.md`, `docs/CR11B_AUTO_080_DISPOSABLE_HOSTED_QUALIFICATION_CONTRACT.md`, and
  `docs/CR3_DECISION_LOG.md`;
- modified: `src/ready-frontier/v1/disposable-qualification.ts`; and
- modified: `tests/ready-frontier-disposable-qualification.test.ts`.

The immutable initial review retained the required SHA-256. No dependency, migration, environment, deployment,
service, credential, provider, database, process, network, cleanup, or operational-client path was added.

## Independently observed checks

| Command or review | Independent result |
|---|---|
| `git status --short`, branch, commit, tree, parent, and recent-history checks | Clean pre-report checkout on the expected branch; exact commit, tree, and report-preservation parent confirmed |
| `shasum -a 256 docs/reviews/CR11B_AUTO_080_INDEPENDENT_REVIEW.md` | Required initial-report digest `343da8c1...32f8c` confirmed |
| `git diff --name-status a0929f1..10eb807` | Seven declared remediation source, test, contract, status, decision, and program paths only |
| `git diff --check a0929f1..10eb807` | Exit 0; no whitespace errors |
| `node --import tsx --test tests/ready-frontier-disposable-qualification.test.ts` | 10/10 passed; zero failures, skips, or cancellations |
| `npm run test:cr11b` | 147/147 passed; zero failures, skips, or cancellations |
| `npm run check` | Exit 0; TypeScript no-emit check passed |
| `npm run lint` | Exit 0; full ESLint gate passed |
| `npm run build` | Exit 0; production build passed |
| `node --test tests/rendered-html.test.mjs` | 2/2 rendered-route checks passed |
| `node --import tsx scripts/verify-migrations.ts` | Exit 0; all 27 migrations applied and 97 PostgreSQL tables verified in the repository verifier |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; no readiness or native attempt |
| Host descriptor inspection | Global `Uint8Array` is writable/configurable; inherited typed-array `byteLength` and `fill` descriptors are configurable; no descriptor was changed |
| Exact source and import review | No live provider, database, process, network, credential, protected-reference, cleanup, consumer, scheduler, dispatch, execution, or deployment client found |
| Private-key source review | Rejection-level mutable `instanceof Uint8Array` and inherited `key.byteLength` reads precede captured cleanup in the shared HMAC path |

No custom probe was created or executed. The new finding is established by the exact source path and read-only host
descriptor inspection. No runtime intrinsic was changed during this review.

## Recorded finding closure

### `AUTO080-IR-001` — exact ambient-fill reproduction closed; broader key-custody property remains open

`disposable-qualification.ts` captures the actual `Uint8Array` and shared typed-array prototypes and the original fill
function at module evaluation. `assertDisposableRuntimeV1` uses a captured descriptor reader, rejects any own fill on
the captured `Uint8Array.prototype`, and requires the captured shared typed-array prototype's fill data property to
still hold the captured function. The check occurs before the request key is copied in every exported operation.

The cleanup no longer performs a property lookup on the private key. `wipeHostUint8ArrayV1` uses captured typed-array
buffer access, the captured `Uint8Array` constructor, captured `Reflect.apply`, and captured fill. For the candidate's
private full-buffer copy, it therefore wipes the complete backing store without consulting current fill behavior.

Post-load replacement of the checked inherited fill and post-load own fill shadowing fail closed before request-key
copying and cannot execute the replacement through AUTO-080. Replacing the current prototype link while leaving the
captured prototypes unchanged is not detected by this narrow guard, but the actual wipe still calls the captured
function directly and does not consult that link. The current fill-specific execution and no-wipe reproduction is
therefore closed.

The implementation assumes a clean runtime when `host-value.ts` and AUTO-080 evaluate. A fill replacement already
present before both modules initialize would be captured as if it were the intrinsic. The repository's documented
same-process-compromise exclusion makes that a startup trust assumption rather than the primary rejection in this
report; the acceptance contract should state it instead of implying native provenance can be established after the
fact.

The finding remains open as a broader key-custody property because a different inherited typed-array surface executes
with the same private key before the now-safe cleanup, as described below.

## `AUTO080-RR1-001` — mutable HMAC key validation can execute caller behavior and copy the request key

**Severity:** high within AUTO-080's request-integrity and private-key-cleanup boundary; no owner or external-effect
authority

AUTO-080 creates a private exact request-key copy through the captured host-value boundary. Construction then calls
`hmacSha256Tag(requestKey, ...)` when it creates the request authentication tag; parsing calls the same helper when it
verifies that tag. The shared helper begins with:

```ts
if (!(key instanceof Uint8Array) || key.byteLength < 32) throw new Error("integrity key invalid");
```

Neither operation is behavior-free under the candidate's modeled post-load shared-runtime mutation:

- the identifier `Uint8Array` resolves the current writable/configurable global binding, so a replacement constructor
  with a hostile `Symbol.hasInstance` receives the private key as its tested value; and
- `key.byteLength` performs an inherited property lookup, so a replacement configurable
  `%TypedArray%.prototype.byteLength` getter receives the private key as `this`.

The AUTO-080 guard verifies only fill. The accepted AUTO-070 source validators do not verify either HMAC key surface.
The exact-host input boundary intentionally uses captured getters and consequently does not execute or reject the later
ambient HMAC read. A hostile replacement can use saved native typed-array operations to copy the key synchronously,
return `true` or the correct length, and permit normal HMAC processing. The replacement runs before the `finally`
cleanup. Captured cleanup zeros the Control Room copy but has no reference to the separately retained bytes.

The existing hostile regression cannot detect this path. It replaces only fill and proves the repair to the original
cleanup call; it does not replace global constructor identity or any inherited binary metadata getter used while the
key is live.

### Required remediation boundary

No private request-key operation may perform `instanceof`, property access, iteration, coercion, or any other mutable
shared-runtime behavior on that key. The HMAC boundary must consume a previously exact, boundary-owned key through
captured and verified host intrinsics, or the complete relevant constructor/prototype/getter identities must be checked
before any private copy exists and the HMAC path must invoke only captured operations.

Hostile regression coverage must, after module load:

1. replace the global `Uint8Array` binding with an accepting `Symbol.hasInstance` implementation;
2. separately replace the inherited typed-array `byteLength` getter with one that attempts to copy its receiver;
3. cover both request construction and parsing, on success and failure paths;
4. prove zero hostile calls, zero retained or copied key material, and complete erasure of every private copy;
5. restore every descriptor in `finally`; and
6. re-verify exact source lineage, replay, substitution denial, projection privacy, and all negative-authority fields.

The clean-module-initialization assumption must also be stated explicitly. If pre-load mutation is intended to be in
scope, the next design needs an out-of-process or otherwise independently anchored intrinsic-trust boundary; capturing
an already replaced function cannot establish that it was native.

## Complete contract re-review

### Source lineage, substitution, and replay

The request still embeds the complete authenticated accepted AUTO-070 plan and successful no-fault report and re-runs
both parsers. It requires `simulated_pass`, no injected fault, eight passes, zero failures, zero qualified proofs, and
all nine outstanding production proofs. The exact accepted implementation commit
`20eeb148ce7ecf59a777f060eacd9245d9948cc8` and review SHA-256
`07033f542a7e3b7167a95d3fa301b90ff3806ec49232cddc878e8fa84353f681` remain pinned.

Strict schemas plus digest and HMAC checks reject ordinary wrong-key, changed-source, re-digested, and re-signed
substitution. Exact replay remains deterministic under the clean runtime. These properties do not contain the private
key passed through the mutable HMAC validation path.

### Chronology, exact input, and caller behavior

Canonical timestamps are retained. Issuance cannot precede accepted fake completion; expiry must follow issuance, stay
within the accepted plan, and remain within one hour. The 1,800-second activity request is separate and fixed.

Existing exact snapshot boundaries reject ordinary accessors and Proxies without executing their traps. Fixed scenario,
operation, and blocker arrays are complete ordered literals. The new finding is not an accepted caller-supplied input;
it is shared-runtime behavior reached with the boundary's own private key.

### Projection, privacy, and negative authority

Projection re-authenticates the request and emits only safe identifiers, resource classes, seven operations, ten
blockers, call/duration ceilings, cleanup requirement, and false capability fields. It omits source bodies, HMACs,
protected references, provider or resource identities, credentials, infrastructure details, process output, backup
material, and raw evidence.

The request still has no owner signature, provider selection, disposable-resource assignment, protected reference,
network, process, database, cleanup, live qualification, production consumer, approval, claim/lease, dispatch,
execution, or external-effect authority. The finding concerns private repository-integrity key custody; it does not
broaden these false fields.

### Absence of a live-effect path

The AUTO-080 source imports only cryptography, validation, repository security helpers, accepted AUTO-070 parsers,
exact-value helpers, errors, and local constants/types. It defines no provider, PostgreSQL, socket, HTTP/TLS/DNS,
process, filesystem, credential, protected-reference, backup, restore, cleanup, scheduler, consumer, dispatcher,
executor, or deployment client. This exact static absence remains accepted as a narrow negative fact.

## No external activity

No external resource was accessed. This review did not contact GitHub, a provider, database, network, credential store,
native key store, protected reference, process, service, worker, deployment target, or cleanup target. It did not install
or download anything, change a runtime intrinsic, start a native qualification, provision or destroy a resource,
perform backup/restore/cleanup, commit, push, merge, or cause an external effect. The only filesystem change is this
uncommitted sanitized review report.

## Final disposition

Exact commit `10eb807c8edd859261aa8dae09bcd5e116f42420`, tree
`a7b764ea434ff9fd93db5e16cc4d162da7bf1092`, is rejected for CR11B-AUTO-080. Preserve this report unchanged under its
handoff SHA-256. Remediate only in a new exact implementation commit and appoint another different independent reviewer.
No live qualification may begin while this finding remains open.

`REJECTED`
