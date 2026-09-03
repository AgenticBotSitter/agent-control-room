# CR13A-LIVE-120 physical native-driver design and qualification boundary

**Status:** architecture contract complete; rejected implementation preserved at
`959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38`; exact remediation
`5a579342b7a03bb013de21663c69a3a6118e11c6` independently accepted; physical qualification remains blocked
**Integration base:** owner-approved LIVE-110 merge `1ee5409c0b66afbd802582459af864ec0d198f5c`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Effect boundary:** documentation and repository-static verification only; no native module import, socket, listener,
port selection, connection, SSH operation, credential access, Hermes/provider call, native process, production contact,
deployment, DNS, hosting, or network effect

## Purpose

LIVE-110 fixed the five-operation vocabulary and proved that a repository fake can rehearse it without gaining native
or activation authority. LIVE-120 fixes the next boundary before any physical driver exists: which component may own
an operating-system listener, which evidence must exist before each transition, which facts remain private, how every
connection is bounded, and how failure, shutdown, restart, and uncertainty fail closed.

This design is not an implementation, readiness pass, owner authorization, platform qualification, or permission to
open a listener. Passing repository tests against a later implementation will remain fake evidence until a separate
owner-attended physical qualification observes the exact native facts defined here.

## Non-collapsible stages

The following stages are separate and must never be inferred from one another:

1. **Design accepted:** this document fixes the physical boundary without native code.
2. **Implementation reviewed:** one unwired driver implements the fixed port under repository fakes and contains the
   only permitted native networking import.
3. **Activation candidate assembled:** exact reviewed implementation identity is bound to an unspent owner window,
   platform runtime, private locator custody, tunnel-peer proof, host-key proof, limits, and cleanup policy.
4. **Owner authorization consumed:** the owner attends the target host, verifies the exact packet, and authorizes one
   bounded native attempt. Repository approval, CI, or a prior authorization cannot substitute.
5. **Physical qualification observed:** the attempt records actual bind, admission, deadline, backpressure, close,
   cleanup, and recovery facts through a trusted platform evidence path.
6. **Independent evidence accepted:** a different reviewer verifies the sanitized signed evidence without repairing
   the harness or repeating an uncertain effect.
7. **Runtime activation separately approved:** only a later exact owner decision may admit the qualified driver into a
   runtime. Qualification never activates it automatically.

Failure at any stage leaves all later stages false. No stage may clear a blocker based solely on matching public
digests, copied records, configuration presence, fake rehearsal, successful CI, or process exit code.

## Component boundary

The future implementation must remain split into four narrow components:

1. **Native driver core:** one server lifecycle with `prepare`, `start`, `status`, `close`, and `recover`. It receives
   only repository-owned exact records and opaque private capabilities. It contains no SSH client, credential store,
   provider client, HTTP route, database connection, approval UI, scheduler, or deployment code.
2. **Private locator broker:** owns the literal bind address and selected private port. Raw locator values never enter
   public contracts, logs, errors, audit payloads, URLs, UI, repository fixtures, or Git history. The driver receives a
   one-use opaque bind capability, not an ordinary address/port object.
3. **Platform evidence signer:** observes native facts and signs an exact bounded result. The driver cannot mint or
   accept its own qualification. Signer trust and key custody remain separate reviewed prerequisites.
4. **Disabled composition port:** the application continues to construct the unconditional disabled listener. The
   native driver is export-only until a later integration block supplies separately accepted activation evidence and
   an exact owner decision.

When implementation is authorized, native networking imports are permitted in exactly one dedicated server-driver
module. Shared contracts, public projections, browser code, API routes, workers, schedulers, Hermes adapters, and
deployment code must not import that module. Static tests must enforce both the one-module allowlist and every denied
consumer path.

## Exact private inputs

`prepare` may consume only one frozen exact input assembled by an architect-owned factory:

- the exact accepted LIVE-110 driver contract;
- exact implementation identity and source-tree digest;
- exact Node.js runtime and target platform identity;
- opaque one-use private bind capability;
- exact owner authorization-window reference, not its secret material;
- exact platform-signer trust reference;
- exact tunnel-peer and accepted host-key custody evidence references;
- connection, idle, admission, drain, shutdown, and total-attempt deadlines;
- frame-byte, chunk, concurrency, and backpressure limits; and
- an exact durable attempt-marker and recovery-ledger reference.

The driver must reject ordinary copies, serialized values, caller-created or re-digested records, extra keys, symbols,
accessors, Proxies, unusual prototypes, callbacks, generic socket factories, arbitrary clocks, arbitrary signers,
commands, environment maps, paths, credentials, SSH configuration, provider configuration, and executable input.

Private inputs are held only for the bounded attempt lifetime and must be released during cleanup. Public output may
contain fixed enums, counts, booleans, durations, bounded digests, and non-locator references. It must not contain a
raw address, port, listener ID, path, PID, host name, user name, endpoint identity, owner identity, tunnel-peer
identity, host key, credential, key material, command, protected frame, provider value, stack trace, or native error
text.

## Driver state machine

The only legal durable states are:

```text
created -> prepared -> starting -> listening -> draining -> closed
                    \-> failed_before_bind
                               \-> ambiguous_after_marker
                                            \-> cleanup_failed
closed -> recovery_checked
failed_before_bind -> recovery_checked
ambiguous_after_marker -> recovery_checked
cleanup_failed -> recovery_checked
```

- `created` owns no native resource and has consumed no bind capability.
- `prepared` proves exact input custody and readiness only. It performs no bind, connect, listen, DNS, SSH, credential,
  provider, or process action.
- `starting` is entered only after the durable pre-effect marker and one-use authorization spend commit atomically.
- `listening` requires an observed successful literal IPv4 loopback bind to the privately brokered locator.
- `draining` rejects new admission, stops frame intake, and begins bounded resource cleanup.
- `closed` requires independently observable listener closure, all admitted connections closed, timers cleared, private
  locator capability released, and no descendant resource retained.
- `failed_before_bind` is permitted only when trusted evidence proves the native bind operation was never called.
- `ambiguous_after_marker` is terminal for that authorization whenever bind/start outcome cannot be proved.
- `cleanup_failed` is terminal whenever full closure cannot be proved by the shutdown deadline.
- `recovery_checked` records one no-reopen reconciliation result. Recovery never starts or reopens a listener.

Every illegal, duplicate, stale, out-of-order, cross-attempt, or cross-process transition fails closed. `start` is
single-use. `close` is repeatable only as an idempotent request for the same terminal result; it cannot erase an
ambiguous or cleanup-failed state. `recover` may observe and reconcile durable truth but cannot retry, bind, connect,
or promote activation.

## Bind and admission invariants

The physical driver must enforce all of these simultaneously:

1. Bind only to literal IPv4 loopback `127.0.0.1`; names, wildcard addresses, IPv6, interfaces, and caller-provided
   alternatives are rejected before the native call.
2. Use only the single private port held by the opaque broker capability. The value is never published or returned.
3. Prove exclusive ownership for the attempt. Address-in-use, lost custody, or conflicting marker state is terminal.
4. Admit at most one active connection. Any additional socket is closed before application bytes are accepted and is
   counted only in private signed evidence.
5. Maintain zero application-level queued connections. Kernel backlog behavior is not described as zero queue; the
   qualification must separately observe and disclose the configured backlog and immediate rejection policy without
   claiming stronger operating-system behavior than was measured.
6. Require an exact unspent admission capability bound to the authenticated tunnel peer, accepted host-key custody,
   listener attempt, connection ordinal, and deadline before frame decoding.
7. Do not infer tunnel authentication from loopback source address. A local process can also reach loopback.
8. Accept exactly one protected frame on the one admitted connection. Trailing bytes, a second frame, additional
   chunks, or input after completion closes the connection and makes the attempt ineligible.
9. Enforce existing maximum frame bytes and chunk counts before allocation or decoding can exceed the fixed limits.
10. Apply transport pause/resume backpressure at the bounded high/low watermarks. A source that continues beyond the
    hard buffered-byte ceiling is closed and the attempt fails.

## Deadlines and resource bounds

The implementation must use repository-owned captured time and timer operations behind an exact internal port. It
must not accept caller clocks or timer functions. At minimum it enforces:

- a total attempt deadline;
- a bind/start deadline;
- an admission deadline from successful listen to the first accepted authenticated connection;
- a connection lifetime deadline;
- an idle deadline between accepted chunks;
- a frame-completion deadline;
- a drain deadline; and
- a final shutdown/cleanup deadline.

All limits come from the accepted contract and may only narrow for qualification. Timer creation, cancellation, firing,
and remaining-resource counts are part of private signed evidence. Late callbacks must observe the terminal attempt
epoch and perform no state transition, output, retry, or new effect.

The exact resource ceiling is one server, one admitted socket, zero application queue entries, one frame accumulator,
the fixed maximum chunk count and bytes, one deadline set, one durable marker, and one evidence result. The driver may
not spawn a child process, thread, worker, shell, SSH client, provider client, HTTP server, or background retry loop.

## Shutdown and cleanup

`close` executes one fixed order:

1. atomically enter `draining` and reject new admission;
2. stop accepting application bytes;
3. close or destroy the admitted socket according to its already-observed state;
4. request server closure through the captured native method;
5. wait only until the bounded drain/shutdown deadline;
6. clear every owned timer and callback reference;
7. release the private bind capability;
8. record final native resource counts and cleanup observations;
9. sign the exact terminal evidence through the separate platform signer; and
10. persist the terminal ledger entry and independent high-water checkpoint.

A graceful close callback alone does not prove cleanup. Qualification must also observe zero retained server handles,
zero admitted sockets, zero live attempt timers, no held locator capability, no automatic restart, and no later
callback changing terminal truth. Missing or contradictory observation becomes `cleanup_failed`; it is never rewritten
as success.

Process signals and application shutdown remain supervisor concerns. The driver may expose an idempotent close request
but must not install global signal handlers, uncaught-exception handlers, process-exit handlers, or automatic startup
hooks.

## Restart and ambiguity

Before any future start, `recover` compares the authenticated append-only attempt ledger, independent high-water
checkpoint, authorization-spend record, and current platform resource observation.

- No marker: report `not_started`; do nothing.
- Definite pre-bind failure with matching terminal evidence: report `failed_before_bind`; require a completely new
  owner window for any later attempt.
- Committed marker without a complete signed terminal record: report `ambiguous_after_marker`; permanently tombstone
  that attempt and authorization.
- Cleanup failure or a possibly retained resource: report `cleanup_failed`; do not reopen or retry.
- Complete closed record with matching high-water and zero resources: report `closed_verified`; do not reopen.
- Ledger deletion, rollback, signature failure, scope mismatch, or unknown future schema: report `integrity_failed`;
  do not read further private state or perform an effect.

Neither process restart, operator refresh, scheduler cycle, nor matching idempotency key may repeat an uncertain native
operation. A later attempt needs a new attempt identity, new owner authorization, new capability, fresh readiness,
and proof that the prior resource no longer exists.

## Native qualification packet

A later owner-attended packet must freeze, before the owner acts:

- exact implementation and repository commits;
- exact source and dependency hashes;
- exact target host platform/runtime identity in sanitized form;
- accepted signer trust and private locator broker versions;
- all limits and deadlines;
- exact allowed native calls and maximum counts;
- one attempt identity and one-use owner window;
- the expected safe output schema;
- failure classification and no-retry rules;
- cleanup commands owned by the harness, with an exact absence check; and
- a different report-only reviewer and immutable evidence destination.

Stage zero and readiness are effect-free and do not consume the attempt. The owner must run the final attached-Terminal
command on the target Mac, type the exact owner phrase, and attend any operating-system prompt. An agent cannot type
the phrase, click a Keychain or firewall prompt, infer owner presence, repair the harness during qualification, or
repeat the attempt after uncertain output.

The first physical qualification should exercise only a disposable local loopback self-probe. It must not start SSH,
contact Hermes, read credentials, reach a provider, accept an untrusted remote peer, use production data, or deploy.
Tunnel-peer and host-key acceptance require separate already-reviewed evidence inputs; the loopback probe cannot mint
them.

## Required implementation review

Before any native attempt, a different independent zero-repair reviewer must attack the exact implementation target:

- import allowlists and runtime non-wiring;
- exact object and capability provenance;
- private locator containment;
- method, callback, receiver, prototype, subclass, thenable, timer, and ambient-intrinsic replacement;
- bind-address and locator substitution;
- duplicate/concurrent start, close, and recovery races;
- admission, capacity, queue, frame, chunk, byte, time, and backpressure limits;
- late events after failure or close;
- incomplete close and retained resources;
- marker, ledger, signer, high-water, and restart rollback;
- ambiguity and automatic-retry bypass;
- fake/native, owner, platform, tunnel-peer, host-key, cleanup, recovery, activation, and authority relabeling;
- raw locator, identity, credential, path, command, frame, native-error, and provider leakage; and
- every static route, browser, worker, scheduler, Hermes, service, deployment, and startup composition path.

Any High, Medium, or Low finding rejects the implementation target. The reviewer performs no repair and no native
effect. Negative evidence is preserved before remediation.

## Design acceptance criteria

1. The physical boundary is narrower than the LIVE-110 contract and cannot widen its operations or limits.
2. Native implementation, evidence signing, private locator custody, owner authorization, qualification, independent
   review, and runtime activation are separate authorities.
3. Literal loopback is required but never treated as peer authentication.
4. One connection, zero application queue, one frame, bounded bytes/chunks, backpressure, and every deadline have
   explicit enforcement and evidence requirements.
5. Start is one-use; ambiguity, cleanup failure, and restart never trigger automatic retry.
6. Ordered shutdown requires independently observable zero-resource cleanup, not merely a close callback.
7. Public records expose no raw locator, host identity, protected identity, credential, path, command, frame, provider
   value, or native diagnostic.
8. The future native module remains unwired and allowlisted to one file until separate activation approval.
9. Repository fakes and CI cannot clear a native, owner, platform, port, tunnel, host-key, deadline, backpressure,
   cleanup, recovery, or activation blocker.
10. Physical qualification is one owner-attended disposable self-probe with a frozen packet, terminal no-retry rules,
    exact cleanup, and a different report-only reviewer.

## Current disposition

The owner separately authorized the bounded repository-code implementation, and exact product
`959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38` now contains one isolated, unwired `node:net` server-driver module.
No physical backend factory or bind-capability issuer is exported, the capability registry has no insertion path, the
module is absent from the connection-registry barrel, and no source consumer imports it. Repository fakes exercised
the fixed lifecycle with zero listener attempts and zero network observations.

This does not accept the implementation or authorize a socket. A different zero-repair reviewer must review the
exact target under packet SHA-256 `e42cde8b401117e8bb71971315fff0219a5e8f17827e7df7a480a42ca967c9b5`.
The private broker/signer composition, runtime wiring, and the first owner-attended physical attempt remain separate
later blocks requiring their own review and exact authority.
