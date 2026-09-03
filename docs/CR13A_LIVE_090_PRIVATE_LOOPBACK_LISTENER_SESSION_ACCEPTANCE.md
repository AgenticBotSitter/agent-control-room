# CR13A-LIVE-090 private-loopback listener session acceptance

**Status:** independently accepted after three remediation rounds and integrated on `main` through owner-approved PR
#238; post-merge CI passed
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

The different re-reviewer independently closed M-001 but rejected remediation target
`89be9d7fb486a3fb5855402073466108a19a75ec`. M-002 showed that an already-rejected same-realm Promise with an inert own
`constructor` data property selecting the captured native Promise constructor was invalid but left unobserved. Under
strict Node rejection handling, that malformed in-process collaborator result terminated the bounded process instead
of returning only the local `integrity_failed` result. Preserve the second negative report at
`docs/reviews/CR13A_LIVE_090_REMEDIATION_INDEPENDENT_REREVIEW.md`; SHA-256:
`ca1b7ef365cd6a9b4fe79e22eade3d48667a8ccc1d8befc2f09bcb6f469803f2`.

Exact second remediation `de840c9aef259db18da3c45e1d4e0549bc0f0d85` keeps every decorated Promise invalid
but safely observes settlement when an own `constructor` is an ordinary data descriptor selecting the captured native
constructor or native default. It performs that descriptor check without reading supplied properties, then uses only
the already captured intrinsic Promise method. Behavioral/accessor constructors, foreign constructor selections,
Proxies, subclasses, and foreign thenables remain unassimilated and unexecuted. The same duplicated safety boundary in
LIVE-060 transport admission is hardened in the same change. Strict-process regressions cover the reported listener
and transport paths, and an additional regression proves a behavioral constructor remains unread.

The third reviewer reconfirmed M-001 and closed M-002 but rejected second-remediation target
`f0a64ae4fab6b0a7d926fca573c9ce324c6b9ee3`. M-003 showed that post-import drift of the ambient
`Promise.prototype.then` made result validation fail as intended, but also prevented use of the already captured safe
observer even while effective constructor/species selection remained demonstrably native. A malformed pre-rejected
collaborator result could therefore remain unobserved under strict Node handling. Preserve the third negative report at
`docs/reviews/CR13A_LIVE_090_SECOND_REMEDIATION_INDEPENDENT_REREVIEW.md`; SHA-256:
`7870ea50f7c84edcd41adffa00191df8f504e3d85099c1d7dae50c37bb78ccfe`.

Exact third remediation `77ef10c2ec9d0912e4d59ca71c95b1886c9ae60e` separates full Promise acceptance from
safe rejection cleanup. Validation still rejects every runtime drift. Cleanup independently resolves the effective
constructor from captured own descriptors and permits only the native default or captured native constructor with the
captured species path, then calls the captured intrinsic observer. Drifted ambient `then` behavior is never called.
Both listener and transport now observe safely before returning an integrity failure if runtime custody changed.
Strict-process regressions reproduce the reported drift at both seams and prove the replacement runs zero times.

## Deterministic evidence

Producer verification for the exact remediation:

- macOS stage zero: pass (`ready_for_runtime_check`), with no native attempt;
- TypeScript and full ESLint: pass;
- focused LIVE-060/070/080/090 suite: 47/47 pass;
- complete connection slice: 89/89 pass;
- complete repository lifecycle: 769/769 pretests, 419/421 core tests with two intentional platform skips, and
  340/340 posttests;
- production build and 4/4 rendered-route checks: pass;
- PostgreSQL migrations `0001` through `0036`: pass with 119 tables; and
- whitespace validation: pass.

The fourth different independent reviewer reproduced 47/47 focused tests, 89/89 connection tests, the complete
769/769 pretest plus 419/421 core test plus 340/340 posttest lifecycle, 4/4 rendered checks, both required diff checks,
and a 29/29 bounded hostile matrix including 22/22 strict-policy Promise cases. The ordinary database wrapper alone
was blocked from creating its local `tsx` IPC listener in the disposable sandbox; the reviewer preserved that failure
and independently ran the listener-free verifier successfully across migrations `0001` through `0036` and 119 tables.
M-001, M-002, and M-003 are closed, with no new High, Medium, or Low finding. The accepted unchanged report is
`docs/reviews/CR13A_LIVE_090_THIRD_REMEDIATION_INDEPENDENT_REREVIEW.md`; SHA-256:
`cd02d7638fa50157db73c54758484dde3f633d2b3814973b577a49679793c4cf`.

## Review and next boundary

The fourth different independent reviewer attacked method capture and receiver binding, ordinary-data observation
capture, actual chunk count, decoder provenance, raw-input reduction, admission single-flight behavior, concurrent
reentry, pending abort, malformed native promises, foreign thenables, post-await runtime custody, policy mismatch,
cleanup after every failure, receipt correlation, safe output, public-digest recomputation, and the
no-listener/no-runtime-wiring boundary. It accepted the exact target with no High, Medium, or Low finding.

Acceptance permits ordinary owner-controlled integration only. It does not authorize a physical listener, SSH tunnel,
credential read, native attempt, production database contact, deployment, or network action. The next native block must
define a concrete default-disabled socket adapter, exact activation authority, real loopback and port evidence, bounded
timers/backpressure, shutdown and process-kill recovery, and a separately owner-authorized disposable qualification.

The rejected review target is `dbdb297aa04ea7465ab636c94ccf1084003cdf27`, containing frozen implementation
`5ff9d9bf8ce3096c50c0fab646f60cfb36a410fe`. Its zero-repair packet SHA-256 is
`88dc35513f595fc08b75b0136bb20c7addb46bbcc8f837a265cd5df25c81d97f`. The exact remediation is
`28a1c0833e8e2b2b3368644536b7442c96bbadcb`. The different reviewer closed M-001 but rejected immutable remediation
target `89be9d7fb486a3fb5855402073466108a19a75ec` under packet SHA-256
`5be8352094f95217c35ff171181d5a3494ed5fff67d4cf11e9dc82d67dbdcc36` because M-002 remained.
Exact second remediation is `de840c9aef259db18da3c45e1d4e0549bc0f0d85`; a third zero-repair reviewer must close
M-002, reconfirm M-001, and find no new High, Medium, or Low defect before ordinary owner-controlled integration. The
immutable second-remediation review target is `f0a64ae4fab6b0a7d926fca573c9ce324c6b9ee3`; packet SHA-256:
`32e552933c8b3f6f7b65b0642bd45352b53f16bee00cdf7311804da67830e15b`.

That third reviewer closed M-002 and reconfirmed M-001 but rejected the target for M-003. Exact third remediation is
`77ef10c2ec9d0912e4d59ca71c95b1886c9ae60e`. A fourth zero-repair reviewer closed M-003, reconfirmed M-001/M-002,
and found no new High, Medium, or Low defect. The immutable
third-remediation review target is `a94241fb4578af7ff8ba2b85afa4d18f2fdd4066`; packet SHA-256:
`82991aed6c64442addd44e7b4c317888264ed2524f2f3f8e0fab5a818d3f5423`.
Accepted report SHA-256: `cd02d7638fa50157db73c54758484dde3f633d2b3814973b577a49679793c4cf`.

The owner approved PR #238. Accepted branch head `ecb5ea373ccb0cdbee1ef036b80ee29730a3ec0b` merged as
`65ea851c123993d7760d6492966845f74ca1d665`; PR CI run `33784095714` and post-merge CI run `33785601437` passed.
