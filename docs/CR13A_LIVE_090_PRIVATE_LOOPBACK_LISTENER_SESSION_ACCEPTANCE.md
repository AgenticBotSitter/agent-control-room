# CR13A-LIVE-090 private-loopback listener session acceptance

**Status:** original target rejected; exact remediation frozen at `28a1c0833e8e2b2b3368644536b7442c96bbadcb`; different-reviewer zero-repair re-review required
**Integration base:** owner-approved LIVE-080 merge `04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d`
**Effect boundary:** repository code, fake admission, and local deterministic tests only; no socket, listener, SSH,
credential, Hermes/provider, native process, production PostgreSQL/VPS, deployment, DNS, or external network effect

## Delivered boundary

`ConnectionEnrollmentPrivateLoopbackListenerSessionV1` is the first complete composition seam from the accepted
LIVE-070 frame decoder, through the accepted and remediated LIVE-080 listener lifecycle, into one LIVE-060 authenticated
transport-admission call. It makes the future native listener thinner: the native layer will provide bounded byte chunks
and trustworthy lifecycle observations, while this session owns decoding, exact sequencing, admission serialization,
receipt correlation, and terminal cleanup.

This is not the physical listener. It imports no socket, TLS, HTTP, datagram, child-process, or SSH implementation. It
has no application route or local-pilot wiring and cannot bind or connect. The tests use a fixed local fake admission;
the block performs no registry or production write.

## Exact session

One session permits only this order:

1. repository-fake loopback bind observation;
2. repository-fake single SSH-tunnel connection observation;
3. one or more exact binary chunks within the accepted frame/chunk ceilings;
4. decoder completion plus exactly one authenticated transport-admission call;
5. connection close with no active or queued work;
6. drain start with no automatic restart;
7. listener cleanup; and
8. one terminal public-safe session receipt.

The session constructs the LIVE-080 frame observation itself. Callers cannot inject a protected frame. It counts
successful decoder pushes and requires the supplied fake observation to match that count before admission. The exact
decoded `rawFrame` and untrusted `deliveryId` cross only the already accepted LIVE-070-to-LIVE-060 reduction. The
session keeps only a digest of that admission input while the downstream call is pending and never places raw frame,
delivery ID, signature, address, host, username, credential, or tunnel material in its receipt.

Admission is single-flight. Once the admission promise exists, another frame completion, close, cleanup, or abort call
is rejected without interrupting or changing the in-flight session. A successful settlement must still match the
listener plan's SSH-tunnel transport, private-loopback visibility, channel identity digest, and frame ceiling before the
session can close. Rejected, malformed, foreign-thenable, or mismatched admission becomes terminal and clears all
retained digests, counts, receipts, decoder bytes, and lifecycle evidence.

This repository-only coordinator does not implement a wall-clock timer around the downstream admission promise. A
future native adapter must supply and independently prove the connection, idle, admission, drain, and close deadlines;
it may not use this fake session as evidence that a native timeout occurred.

## Receipt truth

The strict public receipt binds:

- listener plan and listener lifecycle receipt digests;
- the protected-frame digest and actual decoder chunk count;
- a digest of the exact `{ rawFrame, deliveryId }` admission input;
- admission, ingress, protocol-frame, delivery-evidence, and enrollment-result references or digests;
- registry revision, accepted/duplicate protocol and ledger outcomes, and server receipt time; and
- fixed negative native, effect, and authority facts.

Its digest establishes public consistency only, not authenticity or authority. The receipt explicitly records
`listenerEvidenceMode: "repository_fake"`, `nativeListenerQualified: false`, no actual bind/port ownership/tunnel
authentication/host-key custody/native cleanup, a disabled listener, no network I/O, and no approval, network, command,
lease, or execution authority. Recomputing the public digest cannot change those literals into a valid receipt.

## Recovery and ambiguity

The session never retries admission. If admission succeeds but a later fake close or cleanup step fails, no passing
session receipt is emitted. The accepted LIVE-060 ingress remains idempotent, so a later separately constructed session
may observe a duplicate downstream result; that later success does not erase the failed cleanup evidence. Real
process-kill, admission-timeout, socket-error, and shutdown ambiguity remain native-adapter review cases.

## Original review and remediation

The first independent reviewer reproduced every required gate but rejected the exact target. M-001 showed that calling
`finish()` while the sole authenticated admission was still settling destructively changed the session from `admitting`
to `failed` and cleared its evidence. The downstream call could still succeed, but the caller could no longer complete
the ordered close, drain, cleanup, and correlation receipt. Both an ordinary pending Promise and synchronous reentry
from the admission method reproduced the defect. The immutable negative report is preserved at
`docs/reviews/CR13A_LIVE_090_INDEPENDENT_REVIEW.md`; SHA-256:
`0f3db267c28605f0687d18f831c303c9c1055a6b4e9f64be65b9b50dd3e716bd`.

Exact remediation `28a1c0833e8e2b2b3368644536b7442c96bbadcb` makes `finish()` during `admitting` a
non-mutating `state_conflict`, checked before runtime-custody assertion or any state/evidence change. Regressions cover
both an externally pending admission and synchronous reentry. In each case the first admission can settle, the session
can complete its exact close/drain/listener-cleanup sequence, one correlation receipt can be emitted, and the admission
method is called exactly once. No authority or effect boundary changed.

## Deterministic evidence

Producer verification for the exact remediation:

- macOS stage zero: pass (`ready_for_runtime_check`), with no native attempt;
- TypeScript and full ESLint: pass;
- focused LIVE-060/070/080/090 suite: 43/43 pass;
- complete connection slice: 85/85 pass;
- complete repository lifecycle: 769/769 pretests, 419/421 core tests with two intentional platform skips, and
  336/336 posttests;
- production build and 4/4 rendered-route checks: pass;
- PostgreSQL migrations `0001` through `0036`: pass with 119 tables; and
- whitespace validation: pass.

## Review and next boundary

The different independent re-review must attack method capture and receiver binding, ordinary-data observation capture, actual chunk
count, decoder provenance, raw-input reduction, admission single-flight behavior, concurrent reentry, pending abort,
malformed native promises, foreign thenables, post-await runtime custody, policy mismatch, cleanup after every failure,
receipt correlation, safe output, public-digest recomputation, and the no-listener/no-runtime-wiring boundary.

Acceptance permits ordinary owner-controlled integration only. It does not authorize a physical listener, SSH tunnel,
credential read, native attempt, production database contact, deployment, or network action. The next native block must
define a concrete default-disabled socket adapter, exact activation authority, real loopback and port evidence, bounded
timers/backpressure, shutdown and process-kill recovery, and a separately owner-authorized disposable qualification.

The rejected review target is `dbdb297aa04ea7465ab636c94ccf1084003cdf27`, containing frozen implementation
`5ff9d9bf8ce3096c50c0fab646f60cfb36a410fe`. Its zero-repair packet SHA-256 is
`88dc35513f595fc08b75b0136bb20c7addb46bbcc8f837a265cd5df25c81d97f`. The exact remediation is
`28a1c0833e8e2b2b3368644536b7442c96bbadcb`; a different zero-repair reviewer must independently close M-001 and find
no new High, Medium, or Low defect before ordinary owner-controlled integration.
