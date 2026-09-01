# CR12B-IDEA-110F macOS connector independent review — REV-001

**Disposition:** `remediation_required`

**Reviewed product commit:** `70f5890b3be5162896a585dae458a9a9c02e8036`

**Accepted fixed-bridge report SHA-256:**
`6ed834e8b5c3418bc0bc932e56ae991a9c33f4699b81860f78be194a34a5b9c8`

**Frozen IDEA-110F packet SHA-256:**
`59e79825dd1b537f8388ae4a7bf429a523d1c3d9256d403c7aef5b690a7d7b2f`

**Review capsule:** `CR12B-IDEA-110F-REV-001`

**Reviewer profile:** fresh independent Codex reviewer for this capsule (`gpt-5.6-sol`, high effort)

## Independence and effect boundary

This reviewer differs from every IDEA-110F contributor and from all three prior bridge reviewers. It authored, advised,
and repaired none of the reviewed product source. The target connector, fixed bridge, operation set, enrollment readiness,
and named tests are byte-identical between the frozen product commit and this review integration head.

The review used the existing architect-prepared checkout, exact repository source, deterministic tests, and an
independently authored out-of-tree hostile probe. It installed, downloaded, copied, linked, updated, and repaired
nothing. It made zero Hermes, native, SSH, provider, credential, protected-value, Keychain, vault, listener, service,
external-database, production, deployment, DNS, hosting, or other consequential-effect attempts.

## Result

Five new findings were reproduced: two High and three Medium. The connector remains unconfigured and provider-disabled,
but it cannot yet be accepted because cancellation can still dispatch private work, a late successful create can bypass
session cleanup, private-port errors cross the connector unsanitized, authority domains may alias, and the nominally
opaque connection identifier admits a locator-shaped value.

Passing producer tests were treated only as inputs. The focused connector, bridge, and readiness suites passed 23/23,
the combined CR12B suite passed 149/149, and the full repository lifecycle passed. Those results do not close the
independently reproduced attacks below.

## Findings

### CR12B-110F-REV001-001 — High — late successful create can bypass native session cleanup

**Exact source:** An ordinary operation advances its durable connector state only after the private-port await and
post-await cancellation check at
[`hermes-021-macos-connector.ts:238`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L238) through
[`hermes-021-macos-connector.ts:247`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L247). Route close evaluates the
cleanup gate before it aborts and joins the active operation at
[`hermes-021-macos-connector.ts:250`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L250) through
[`hermes-021-macos-connector.ts:270`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L270). The producer race test
records the same ordering but expects direct route close at
[`idea-lab-hermes-021-macos-connector.test.ts:161`](../../tests/idea-lab-hermes-021-macos-connector.test.ts#L161) through
[`idea-lab-hermes-021-macos-connector.test.ts:188`](../../tests/idea-lab-hermes-021-macos-connector.test.ts#L188).

**Reproducible attack:** Open one route. Pause `session.create` in the private port. Start route close, let the connector
abort the request, then have the private port ignore abort, submit a valid `created` receipt, and return success. Record
every private-port call.

**Observed result:** The create returned a syntactically successful private result, the public operation rejected because
close had started, and route close then dispatched without any `session.interrupt`, cleanup `session.status`, or
`session.close` call. The trace was `open`, `session.create`, late successful return, `route.close`.

**Violated invariant / affected boundary:** Once a create may have succeeded, route close must not bypass at least one
native session cleanup attempt. An abort is not proof that the native session was not created. This affects the
connector lifecycle and cleanup boundary and can leave cleanup truth dependent only on a later route-close assertion.

**Missing regression:** No test requires a cleanup operation when an in-flight create returns success after abort. The
current race regression explicitly accepts the unsafe direct route-close sequence.

**Smallest safe remediation:** Mark create as cleanup-requiring before its private dispatch, preserve that truth across
abort and uncertain return, and refuse route close until at least one session cleanup operation has been attempted after
the active call settles. Invert the existing race expectation and add late-success, late-throw, and malformed-return
variants. Do not retry create.

### CR12B-110F-REV001-002 — High — cancellation signals remain behavioral and pre-aborted work still dispatches

**Exact source:** `exactInput` accepts any non-Proxy value satisfying `instanceof AbortSignal` at
[`hermes-021-macos-connector.ts:87`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L87) through
[`hermes-021-macos-connector.ts:93`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L93). The active-call helper then
uses dynamic `aborted`, `addEventListener`, and `removeEventListener` property access at
[`hermes-021-macos-connector.ts:289`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L289) through
[`hermes-021-macos-connector.ts:310`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L310). When the parent signal is
already aborted, the helper aborts its child but returns it; open and ordinary operation still call the private port at
[`hermes-021-macos-connector.ts:184`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L184) through
[`hermes-021-macos-connector.ts:186`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L186) and
[`hermes-021-macos-connector.ts:238`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L238) through
[`hermes-021-macos-connector.ts:240`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L240).

**Reproducible attack:** First add an own `aborted` getter to a genuine `AbortSignal` and call route open. Then repeat
with untouched signals aborted before route open and before `session.create`.

**Observed result:** The hostile getter executed and open dispatched. Each pre-aborted call also reached the private port
once before the connector rejected the returned result. No Proxy was needed. The private-port call therefore crossed a
known cancellation boundary.

**Violated invariant / affected boundary:** Host values must not execute caller behavior, and known cancellation before
an effect-capable private dispatch must prevent that dispatch. This affects exact host capture, cancellation, and the
one-attempt private-effect boundary.

**Missing regression:** Producer coverage checks top-level request accessors and Proxies but not altered genuine
`AbortSignal` descriptors/prototypes, post-capture mutation, or pre-aborted open and ordinary operations with a zero-call
expectation.

**Smallest safe remediation:** Introduce a host-intrinsic exact AbortSignal observer that rejects own properties,
prototype drift, subclasses, and Proxies without dynamic property lookup. Refuse open and ordinary-operation dispatch
when it reports already aborted. Keep cleanup safety separately explicit so cancellation cannot suppress mandatory
cleanup. Add getter, setter, descriptor, prototype-mutation, pre-abort, and abort-at-each-await regressions.

### CR12B-110F-REV001-003 — Medium — private-port exceptions cross the connector unchanged

**Exact source:** Open, operation, and close catch blocks rethrow the caught value without safe mapping at
[`hermes-021-macos-connector.ts:214`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L214) through
[`hermes-021-macos-connector.ts:216`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L216),
[`hermes-021-macos-connector.ts:245`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L245) through
[`hermes-021-macos-connector.ts:247`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L247), and
[`hermes-021-macos-connector.ts:285`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L285).

**Reproducible attack:** Have the private port throw a unique sanitized Error instance during route open and compare the
connector rejection by object identity.

**Observed result:** The connector rejected with the exact same Error object. A private implementation could therefore
carry native locator, protected-value, gateway, provider, profile, or native-session detail across this trust boundary.
The accepted gateway later maps execution failures, but the connector contract itself does not sanitize the exception.

**Violated invariant / affected boundary:** Private/native diagnostics must not cross into Control Room errors. This
affects error sanitation and safe composition, including any caller that observes or logs the connector or bridge error
before the outer gateway maps it.

**Missing regression:** Existing uncertain-open coverage proves no retry but does not assert safe error type, code,
identity replacement, or absence of private diagnostic text for open, operation, and close.

**Smallest safe remediation:** Convert every private-port failure and non-safe thrown value to a new bounded
`IdeaLabErrorV1` code after recording only internal one-attempt state. Never retain, wrap, concatenate, or rethrow the
private value. Add identity and message-sentinel regressions at all three methods.

### CR12B-110F-REV001-004 — Medium — distinct authority digests may alias

**Exact source:** Open schemas validate each digest's syntax but never require domain distinctness at
[`hermes-021-macos-connector.ts:39`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L39) through
[`hermes-021-macos-connector.ts:49`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L49). The connector stores and
later compares the supplied values independently at
[`hermes-021-macos-connector.ts:180`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L180) through
[`hermes-021-macos-connector.ts:183`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L183) and
[`hermes-021-macos-connector.ts:224`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L224) through
[`hermes-021-macos-connector.ts:231`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L231).

**Reproducible attack:** Supply the same well-formed digest as connector route, permit, profile identity, and
conversation identity during open, and have the private port mirror the supplied bindings in an otherwise valid receipt.

**Observed result:** Route open succeeded and private dispatch occurred. Once domains alias, swapping or duplicating the
fields is not observable through the connector's equality checks.

**Violated invariant / affected boundary:** Route, permit, profile, conversation, and lease authority must remain
domain-separated so one authenticated value cannot stand in for another. This affects route and authority binding.

**Missing regression:** No connector test aliases any pair of authority fields or the returned lease digest.

**Smallest safe remediation:** Reject pairwise equality across route, permit, profile, conversation, and returned lease
digests before accepting open, and retain domain-separated digest construction in signed enrollment. Add every pairwise
alias and receipt-alias regression.

### CR12B-110F-REV001-005 — Medium — connection identity does not prove locator-free opacity

**Exact source:** Route open accepts `connectionId` through the generic ID schema at
[`hermes-021-macos-connector.ts:39`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L39) through
[`hermes-021-macos-connector.ts:49`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L49). That schema allows dots and
colons at [`schemas.ts:18`](../../src/idea-lab/v1/schemas.ts#L18), while the connector retains and sends the value to the
private port at
[`hermes-021-macos-connector.ts:180`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L180) through
[`hermes-021-macos-connector.ts:186`](../../src/idea-lab/v1/hermes-021-macos-connector.ts#L186).

**Reproducible attack:** Put a documentation-only host-and-port-shaped fixture into `connectionId` and submit an
otherwise valid local route open.

**Observed result:** The value passed schema validation, entered connector state, and reached the private port. The type
name `connectionId` does not prove that the value is an opaque enrollment identity rather than a native locator.

**Violated invariant / affected boundary:** Hostnames, ports, SSH and gateway locators must remain solely within the
Mac-private port and must not enter Control Room input or state. This affects native-locator custody for both local and
SSH route modes.

**Missing regression:** Source scanning checks literal client tokens, but no runtime regression attacks locator-shaped
values inside allowed ID fields.

**Smallest safe remediation:** Replace the Control Room-facing connection identifier with a domain-separated connection
identity digest whose private mapping is held only by the Mac-private port. Bind that digest through signed enrollment
and reject all raw locator-shaped identifiers before connector construction or dispatch.

## Whole-boundary attack results

| Boundary / attack | Independently observed result |
|---|---|
| Exact host boundary | Top-level getters, setters, non-enumerable fields, unknown fields, symbols, inherited state, null/custom prototypes, subclasses, object Proxies, callable Proxies, nested parameter behavior, and receiver loss were traced and exercised. Ordinary records fail closed and concrete private-port receivers survive. Altered genuine AbortSignals remain the exception in CR12B-110F-REV001-002. |
| Route and authority binding | Omitted, malformed, overlong, wrong route, attempt, permit, lease, profile, conversation, runtime, source-manifest, transport, and operation values reject or fail before later operation dispatch. Pairwise digest aliasing and locator-shaped `connectionId` remain open in CR12B-110F-REV001-004/005. No expiry field enters this connector; permit freshness remains a prior gateway obligation. |
| Lifecycle and concurrency | Before-open, duplicate-open, out-of-order, skipped, repeated, cleanup-only, duplicate-close, after-close, uncertain-open, uncertain-operation, caller-abort, route-close, late-return, and no-retry paths were reviewed. One attempt and no automatic retry hold. Late successful create cleanup does not hold, as CR12B-110F-REV001-001 shows. |
| Receipt sanitation | Extra, unknown, inherited, symbol, accessor, Proxy, locator-shaped, malformed, wrong-binding, and mutable open/operation/close results were attacked. Exact snapshots reject top-level behavior without traps; the fixed bridge deep-snapshots events and rejects semantic drift. Private exceptions are not sanitized, as CR12B-110F-REV001-003 shows. |
| Successful route close | Accepted close receipts require exact route, attempt, permit, session-closed, lease-released, disposable-profile/workspace removal, and zero retained references. Duplicate close and calls after close reject. This proof does not repair the missing pre-close session cleanup attempt in finding 001. |
| Default composition | The exported disabled record is frozen with no private port, signer, signed route, connection attempt, SSH connection, native attempt, provider call, live-panel eligibility, or execution authority. No production composition constructs this connector. |
| Client/source absence | Connector source contains no process, filesystem, socket, fetch, SSH client, credential-store, Keychain, protected-value, signer, environment, gateway, provider, deployment, or generic-shell client. It does not modify Hermes. |
| Upgrade boundary | Runtime version/revision, fixed source manifest, fixed operation set, product commit, accepted bridge report, and review packet are pinned. Any connector, private-port, source-manifest, runtime, signer, route, protocol, or Hermes-source change invalidates this report and requires new evidence. |

## Evidence classification and retained blockers

**Observed:** exact repository source at the frozen product commit; byte identity at the integration head; exact bridge
report and packet hashes; the five findings; source-linked boundary traces; focused 23/23 tests; the 149/149 CR12B suite;
the complete deterministic command outcomes; the independent seven-scenario hostile probe; disabled composition; and zero
native or external effects.

**Documented only:** Hermes Desktop owns local/SSH routing, pooling, reconnect, host/user/port/key selection, protected
values, gateway endpoint, profile path, and native session identifiers; the source manifest describes the pinned 0.21
revision.

**Inferred:** A future correctly remediated and enrolled Mac-private port could preserve locator custody and implement the
fixed route. That inference does not prove real private-port provenance, installed source bytes, signer custody, route
behavior, cleanup behavior, or Hermes compatibility.

**Blocked/unobserved:** remediated connector; new independent remediation review; enrolled trusted node signer; accepted
signed route; effect-free preflight; refreshed owner packet; fresh owner authorization; owner-attended native
qualification; provider call; native receipt review; architect acceptance; live-panel owner window; production
PostgreSQL/checkpoint/key custody; monitoring; hosting; deployment; DNS; and public infrastructure.

**Unsupported:** Any claim that this report approves or merges the connector, configures a port, enrolls a machine,
signer, or route, qualifies Hermes, proves a real local/SSH route, observes a provider call, accepts a native receipt,
authorizes a live panel, approves production storage, hosts, deploys, or grants an external effect.

## Deterministic verification

All commands used the existing prepared dependencies. No install, update, repair, native action, or external product
effect occurred.

| Command | Exit | Result |
|---|---:|---|
| independent out-of-tree hostile probe | 0 | Seven finding scenarios reproduced; zero native/provider/external effects |
| focused connector/bridge/readiness suites | 0 | 23/23 passed |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | 0 | `ready_for_runtime_check`; Node and pnpm policy resolved |
| `npm run check` | 0 | TypeScript passed |
| `npm run lint` | 0 | ESLint passed |
| `npm run test:cr12b` | 0 | 149/149 passed; 0 failed, 0 skipped |
| `npm test` | 0 | pretest 769/769; core suite passed with its two intentional platform skips; posttest 228/228; 0 failures |
| `CI=true npm run test:build` | 0 | production build passed; 3/3 rendered routes passed; dynamic-classification warning only |
| `npm run db:verify` | 0 after scoped local IPC permission | 32 migrations applied; 110 PostgreSQL tables verified |
| `git diff --check integration/cr12b-idea-110f-connector-review...HEAD` | pending report commit | Run after this report-only implementation commit |

The first sandboxed `npm run db:verify` invocation exited 1 before migration execution because `tsx` could not create its
local temporary IPC socket (`EPERM`). The identical command passed with permission only for that local IPC socket. No
repository, dependency, database contract, or product repair occurred.

## Final decision

`remediation_required`. The provider-disabled default remains truthful and no external effect occurred, but exact product
commit `70f5890b3be5162896a585dae458a9a9c02e8036` does not satisfy the frozen connector packet while the five findings above
remain open.

This report does not approve, merge, configure, enroll, qualify, contact, host, deploy, or grant authority. Every retained
blocker remains mandatory, and any remediation requires a new exact implementation commit and a different independent
report-only review.
