# Protected Linux Codex outer-installer source plan

**Status:** active implementation plan. The source-only current-admission
exchange (LCOI-2), opaque receipt-ingress capability (LCOI-4), and
session-owned Codex ingress (LCOI-5) are implemented and tested. All remain
unmounted until a protected installed-state owner exists. No installation
contract is minted by this document.

This plan covers the first supported Linux Codex route only. It identifies the
existing source that must be reused and the smallest missing composition
boundaries between protected installed state, the authenticated node session,
Codex execution, and canonical controller receipt/result intake.

It does not install anything, open a database, read a credential, connect a
node, qualify Codex, or make a worker ready. No path, account, endpoint,
certificate, key reference, or host identity is recorded here.

## Source progress update

LCOI-2 now belongs to `PortableNodeBridge` and its shared durable journal. It
reserves the exact queue-bound current-admission request before its one send,
accepts only the matching signed response, and refuses uncertain, stale,
duplicate, oversized, or mismatched replies. LCOI-4 now issues a separate,
opaque, one-use receipt-ingress capability from the private remote composition;
it derives the task reference and time from protected pending state instead of
caller input. Neither boundary starts Codex or makes a worker ready. The
remaining work is protected installed-state construction and mounting at the
real session ingress, not another transport or database.

LCOI-5 is now complete in source too: a branded, one-use Codex ingress is
captured by the authenticated `ServerNodeSession`. The session owns the
responder, result receiver, signing, bounded sends, and immutable queued
reference, and rechecks current canonical permission before result publication.
It refuses replay, expiry, revocation, identity/profile/connection mismatch,
copied capabilities, and caller-supplied receiver substitution. It remains
unmounted until LCOI-1 can create a genuine protected Linux installation.

## Why this change is documentation only

The current sources now have the needed message-level operations, but they do
not yet have a provenance-bearing Linux installed-state owner to construct
them. That owner must prove that the bridge, journal, trust, pin, key, session,
responder, and receipt resources all come from one protected installation.

An outer wrapper that merely passes ordinary JavaScript objects together would
still create a false readiness signal. It could not prove the installed source
of those resources, so no installation capability is minted until LCOI-1 has a
real Linux custody implementation.

## Existing source to reuse unchanged

### Linux node state and signing custody

| Required input | Existing source | Reuse rule |
| --- | --- | --- |
| Durable node bridge journal | `SqliteBridgeJournal` in `src/node-bridge/journal.ts` | Open one pre-created owner-only file and retain it for bridge, Codex delivery, activation, result return, and reconnect evidence. Do not create a second Codex journal for the node protocol. |
| Durable server trust state | `SqliteNodeSecurityStateRepository` in `src/node-policy/v1/persistent-security-state.ts` | Open its distinct artifact and high-water databases from protected installed configuration. Its current server-trust revision and server-key resolver are the trust authority. |
| Owner approval pins | `PinnedApprovalTrustStore` in `src/node-policy/v1/pinned-approval-trust.ts` | Construct it from protected owner pin data against the same security repository and clock. It is not interchangeable with server trust. |
| Linux node signing key | `createNodePrivateKeyStore()` and `EncryptedFileNodePrivateKeyStore` in `src/node-policy/v1/private-key-store-factory.ts` and `encrypted-file-key-store.ts` | Select only the Linux `encrypted_file` provider, with the protected envelope loader and separately protected unwrap source. Unlock before node admission and dispose on every close/failure path. Never export the key or substitute a structural signer. |
| Frame signer | `ProtectedStoreFrameSigner` in `src/node-bridge/protected-store-signer.ts` | Derive it inside the resource owner from the exact unlocked key store. Do not accept it as configuration. |
| Server frame authentication | `NodeProtocolAuthenticator` plus the bridge journal replay guard in `src/node-protocol/v1` | Bind the same security repository, journal, transport identity, and bounded rate limiter used by the reconciled connection. |

`validatePrivateNativeStatePaths()` in
`src/node-bridge/private-native-configuration.ts` is useful precedent for
owner, mode, realpath, link-count, alias, and SQLite-sidecar checks. The Linux
Codex installer needs a Codex-specific validator because
`openPrivateNativeConfiguration()` constructs a Hermes runtime and does not
expose an installable Codex bridge. Do not widen or reuse that Hermes factory
as a generic path opener.

### Authenticated Codex node route

| Required input | Existing source | Reuse rule |
| --- | --- | --- |
| Reconciled signed node bridge | `PortableNodeBridge` in `src/node-bridge/bridge.ts` | Build one bridge with the Codex delivery, activation, current-admission-read, and result-return features. The bridge and every Codex handler must share one journal, signer, authenticator, identity, clock, and connection lifetime. |
| Dispatch intake | `CodexDispatchIntakeHandlerV1` in `src/node-bridge/codex-dispatch-handler.ts` | Construct from installation-bound enrollment, connector-profile, workspace-intent digests, approval pins, server trust, journal, and clock. It records only delivery evidence. |
| Activation intake | `CodexActivationIntakeHandlerV1` in `src/node-bridge/codex-activation-handler.ts` | Construct only after an exact current-admission authority is privately owned. It records acknowledgement evidence and grants no execution authority. |
| Current admission | `createPrivateCodexCurrentAdmissionReaderV1()` and `createPrivateCodexInstalledNodeEntryV1()` in `src/node-bridge` | Keep the reader private. The installed entry already rejects fake bridge/journal/trust/key objects, burns uncertain issue attempts, rechecks activation and trust state, and returns only a one-use session capability. |
| Execution-session fence | `createPrivateCodexSessionOwnerV1()` and `consumePrivateCodexSessionCapabilityV1()` | Consume once into the bounded worker composition. Recheck bridge generation, enrollment, activation, current admission, and trust revision before every effect. |
| Codex process and result route | `createCodexNativeProcessAcquisitionV1()`, `createCodexWorkerCompositionV1()`, `createCodexResultSenderV1()`, and `PortableNodeBridge.sendCodexResultReturn()` | Use the reviewed Linux descriptor-acquisition boundary and existing v3/v4 permit/activation/result contracts. A generic controller-worker packet or receipt is never Codex execution authority. |

The existing `openPrivateCodexConfigurationV1()` is not the missing outer
installer. It opens only bridge/start observation journals and deliberately
accepts authority, workspace, and process ports from its caller. It remains a
lower-level host owner beneath the future protected composition.

### Controller resolver, receipt, and result intake

| Required input | Existing source | Reuse rule |
| --- | --- | --- |
| Canonical remote target resolver | Closure-owned resolver inside `createPrivateRemoteControllerWorkerCompositionV1()` in `src/harness/v1/private-remote-controller-worker-composition.ts` | Reuse it unchanged. It binds the exact canonical task, enrolled worker, adapter revision, connector profile, authenticated `ServerNodeSession`, and current revocation fence. Do not introduce a second resolver or broker. |
| Generic packet materialization | `RemoteControllerWorkerMaterializerV1` | Reuse the existing canonical PostgreSQL intent and receipt store. Generic delivery is topology transport only. |
| Generic receipt intake and recovery | The composition's `receiptIntake.accept()` and `.recover()` | Mount these exact bound methods in the installed server-session ingress. They reconstruct the packet from canonical records and must remain paired with the same composition and session. |
| Codex dispatch receipt | `TaskAssignmentCoordinator.receiveCodexDeliveryReceipt()` through `ManagedNativeSessions` | Retain the existing authenticated Codex-specific receipt path. It is separate from the generic controller-worker receipt. |
| Current-admission responder | `createCodexCurrentAdmissionReadResponderV1()` in `src/web/v1/codex-current-admission-read.ts` | Mount only in the authenticated Codex session. It must reread canonical permit, route, profile, enrollment/pin, lease, and queued evidence for the exact request. |
| Codex result intake | `CodexResultIntakeV1` plus `ServerNodeSession.acceptCodexResultReturn()` | Reuse the existing qualification-bound canonical publisher, artifact storage, pending review target, and result receipt. Generic remote receipt intake cannot replace this path. |

## Smallest missing source boundaries

Implement these in order. Each boundary must remain separately reviewable and
must not start Codex during construction.

### LCOI-1: protected Linux installed-state owner

Add one Linux-only owner that:

- accepts one already-verified, release-bound installed-configuration
  capability, not ordinary paths or environment variables;
- opens the bridge journal, the two security-state databases, and any required
  Codex start/result journals after exact owner/mode/realpath/identity checks;
- constructs owner pins and the encrypted-file key store internally;
- proves installation, tenant, node, node class, key reference, enrollment,
  connector profile, workspace intent, release, and journal bindings agree;
- unlocks key custody before exposing a node-entry factory;
- owns close order and turns any partial-open or cleanup uncertainty into a
  permanent refusal; and
- exposes no raw database, path, credential, key, signer, handler, or mutable
  configuration object.

Return only an opaque, one-use factory for LCOI-2. Do not return a readiness
boolean.

**Current custody research:** the reusable stores reopen SQLite files by name,
including ordinary sidecar files, so this owner needs a qualified Linux
custody mechanism rather than another TypeScript path validator. The evaluated
options and their licenses are recorded in
[`LINUX_CODEX_SQLITE_CUSTODY_CANDIDATES.md`](LINUX_CODEX_SQLITE_CUSTODY_CANDIDATES.md).
The leading candidate is a separately identified, tightly scoped trusted state
process that reuses the current stores; it is not selected or qualified merely
by this reference.

### LCOI-2: reconciled Codex bridge owner

**Source progress:** complete. `PortableNodeBridge` now owns the durable,
one-send current-admission exchange and the private remote composition owns
its receipt ingress. This section remains the mounting rule for LCOI-1: the
future installed-state owner must create and retain those existing components,
not recreate their transport or journal behavior.

Add one bridge composition that constructs the concrete handlers and
`PortableNodeBridge` from LCOI-1 resources. It must own the transport and one
connection generation. Its public surface should be limited to:

- `run(signal)` for the bounded authenticated/reconciliation loop;
- one opaque, queue-bound current-admission exchange used only by LCOI-3; and
- `close()` with bounded drain/disposal.

The current-admission exchange must durably reserve the signed request before
the only send, route only the exact causally linked response, and burn the
request on uncertain send or lost response. It must not expose an arbitrary
`send`, `receive`, resolver, verifier, or callback port. This is the smallest
required change below `createPrivateCodexInstalledNodeEntryV1()`: either add an
exact exchange lane to `PortableNodeBridge`, or add a bridge-owned companion
whose provenance is unforgeable and whose journal transaction is shared. Do
not pass the response through the bridge's generic `receive()` default branch.

### LCOI-3: installed node-entry and worker owner

After reconciliation, privately join the exact bridge, journal, security
repository, approval store, key store, and clock with
`createPrivateCodexInstalledNodeEntryV1()`. The owner must:

1. issue one queue-bound read through LCOI-2;
2. accept only its exact signed response;
3. consume the returned session capability once;
4. bind it to the existing v3/v4 activation and
   `createCodexWorkerCompositionV1()`;
5. keep initial start and recovery mutually exclusive; and
6. own worker, bridge, journal, approval-store, security-store, and key-store
   retirement.

Only this boundary may expose the bounded `start`, `recoverAndReturn`, and
`close` operations. Construction still reports `startsWork: false` and grants
no execution authority.

### LCOI-4: installed controller receipt ingress

**Source progress:** complete. The private remote composition now creates the
separate opaque, one-use receipt-ingress capability described below. LCOI-1
must retain and mount it only for the same authenticated server session.

Retain the complete value returned by
`createPrivateRemoteControllerWorkerCompositionV1()` for the lifetime of its
authenticated `ServerNodeSession`. Capture a second opaque startup capability
for `receiptIntake`, separate from the existing queue-only capability. Mount it
where raw `controller.worker.delivery.receipt` and
`controller.worker.delivery.receipt.recovery` frames enter the exact session.

The ingress must derive the canonical materialization reference from protected
pending-session state; no browser, queue worker, or remote node may supply that
reference. Ordinary receipt and recovery must serialize with session
replacement, revocation, and queue settlement. Only a canonically persisted
receipt may turn the queue worker's current unresolved send into delivered.

### LCOI-5: controller Codex read/result mounting

**Source progress:** complete. `ServerNodeSession` now owns the branded,
one-use mount and both protected ingress operations. LCOI-1 still must create
the authentic installed session; it must not reintroduce this seam through a
generic operator callback.

Mount the current-admission responder and `CodexResultIntakeV1` on the same
installed Codex `ServerNodeSession`. Require the negotiated Codex feature set,
the same enrolled node/key/connection, the exact activation, the qualified
connector profile, and current revocation state. The current-admission answer
and result receipt must use the server session's protected signer and bounded
send path.

#### Historical source blocker (resolved in source)

Before the session-owned mount was implemented, LCOI-5 was not safe to mount
from the old ingress types. This record explains why the solution is a private
session mount rather than a generic callback; it is no longer an open source
architecture blocker.

1. `ServerNodeSession` owns the negotiated identity, replay protection,
   protected signer, bounded send path, activation state, and result-return
   state, but it has no current-admission-read intake.  Its existing
   `acceptCodexResultReturn()` instead accepts a caller-supplied result intake
   for each raw frame.  Retaining the result receiver outside that call would
   turn it into a generic callback port rather than an installed-session-owned
   capability.
2. `createCodexCurrentAdmissionReadResponderV1()` independently authenticates
   raw bytes and returns an unsigned response.  It cannot use the session's
   private signer or bounded send path, and pre-authenticating the same frame
   in the session would consume the replay record before the responder reads
   it.  A generic raw-frame router or a second authenticator would break the
   required single session/key/connection ownership.
3. The only present raw-frame dispatcher is `ManagedNativeSessions`.  It is a
   generic operator layer and exposes separate `codexResult` handling; it has
   no current-admission route and no private holder for an exact responder and
   result receiver.  Extending it would violate this boundary by making the
   protected Codex pair configurable through generic operator routes.
4. Result-return intake is scoped to the activation stored in the session, but
   its current public intake contract does not receive the original queued
   reference needed to re-read the permit, route, profile, enrollment/key,
   lease, and revocation state at result time.  The responder already performs
   that full canonical re-read for admission reads.  Reusing only its historic
   activation digest for results would make revocation/profile changes fail
   open.

The missing smallest boundary is therefore a **branded
`ServerNodeSession`-owned Codex ingress mount**, not a bridge, journal, or
generic operator change.  It must capture one responder and one result
receiver privately at construction; authenticate every inbound frame exactly
once through the session; bind the mount to the negotiated Codex feature set,
node key, connection generation, activation, and qualified profile; and offer
only named current-admission-read and result-return receive operations.  The
session must itself sign and bounded-send the admission response and result
receipt.  Its private result channel must additionally carry the immutable
canonical queued reference solely to a mount-owned revocation recheck before
canonical publication.  Until that typed session seam exists, no installed
capability is minted and no Codex work can start.

## Mandatory fail-closed tests

Each future boundary requires adversarial tests before it may mint an installed
capability:

1. reject relative paths, links, hard-link aliases, weak modes, wrong owner,
   changed inode, SQLite sidecar substitution, aliased databases, and path
   replacement after validation;
2. reject structural, proxied, subclassed, copied, or own-method-overridden
   bridge, journal, security, approval, key, session, resolver, and receipt
   objects;
3. reject mixed installation, release, tenant, node, node-class, key-reference,
   enrollment, profile, workspace, and journal bindings;
4. reject missing/locked/wrong-provider key custody, key change after
   reconciliation, unwrap failure, disposal failure, and reuse after close;
5. prove one bridge journal and one connection generation own dispatch,
   activation, current-admission read, result return, acknowledgements, and
   reconnect evidence;
6. burn current-admission issue before send; reject lost send reply, changed
   causation, duplicate response, oversized response, stale/rotated server
   trust, changed activation, expired lease, and revoked enrollment;
7. reject generic delivery receipts as Codex execution authority and reject
   Codex dispatch receipts as generic controller-worker settlement;
8. accept a generic receipt only from the exact enrolled worker and session;
   reject wrong task, attempt, lease, node, worker, adapter revision,
   enrollment, connection, signature, expiry, and canonical packet digest;
9. after reconnect, recover only an already-journaled exact receipt, never
   resend the packet, restart Codex, or create a second result;
10. reject a result before qualification, after qualification expiry, after
    activation/profile change, on wrong result bytes, or after revocation;
11. abort and close every partially constructed resource in reverse ownership
    order; surface cleanup uncertainty and never delete retained journals; and
12. prove construction, status inspection, current-admission read, generic
    receipt recovery, and close do not start Codex or grant execution authority.

## Completion evidence

Source completion requires focused tests for LCOI-1 through LCOI-5, the full
TypeScript and lint lanes, existing Codex delivery/start/result suites, generic
remote delivery/recovery suites, and a two-worker source journey. This remains
source evidence only.

Worker-ready may be claimed only after a separate owner-attended Linux
qualification verifies the selected release, executable, authentication,
descriptor acquisition, workspace, start/read/stop behavior, result return,
complete cleanup, protected key/credential custody, and the exact installed
controller/node compositions. No source test can substitute for that gate.
