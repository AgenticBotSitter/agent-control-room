# CR14C canonical native progress integration

Status: implementation candidate; independent acceptance is recorded separately.

## Scope and authority

This is the **evidence half** of C-WORK: a native run's durable snapshot reaches its exact canonical
task through the existing authenticated node protocol, durable bridge outbox and PostgreSQL-compatible
harness-run store. It is not a replacement scheduler or execution authority. The native adapter's
`NativeAuthority` composition, actual task dispatch, final artifact transfer, owner review commands,
private task pages and real-host rehearsal are still separate remaining work.

Registration is a trusted coordinator operation after local admission, not a browser operation or an
owner-signed permission. The helper creates no lease or admission. The receiving store checks an
existing active attempt, canonical project/job/input digest, assigned node, exact lease/epoch and
deadline within that lease. Registration serializes on the attempt and permits only one native run for
that attempt. It retains the exact native binding digest and session digest. Registration
may be replayed after progress only with the identical initial binding; it returns the existing observation
without resetting it or recreating execution authority. Registration
does not assert that an agent has actually started, that a profile is qualified, or that an effect was authorized.
The existing native start, policy/ceiling, qualification, pre-effect marker and credential gates remain required.

No application entry point activates this pipeline. No native HTTPS transport is newly instantiated.
All new tests use in-memory or explicitly disposable SQLite/PGlite and synthetic signing keys. Native
adapter integration uses an explicitly fake authority and transport: it is not proof of live admission.

## Wire and persistence

`harness.native.snapshot` is an additive node-to-server message in the existing v1 signed envelope.
Senders must offer and negotiate `harness.native.snapshot.v1` before publication. Older peers retain
queued evidence without receiving an unknown message. The receiver requires a transport-derived
connection ID and identity and authenticates the existing key, principal, signature, expiry, replay
sequence and rate limit before business persistence. Its fixed 16 KiB envelope bound is below the
generic protocol limit. Observations cannot postdate the signed send time; upstream updates cannot
postdate their local observation. Hosts whose clocks violate this constraint need clock correction,
not fabricated timestamps.

The body contains canonical run/job/attempt/project and lease identity, binding/session digests, a
hashed native handle, native snapshot version, observed state, fixed activity/reason categories and
bounded nullable usage/result claims. It contains **no** native run/session handle, prompt, result
text, credentials, profile/destination configuration, local path, raw error, tool argument or reasoning.
Final text remains in the private native journal pending the artifact integration. The result hash is
SHA-256 of its exact UTF-8 bytes and is a producer claim, not independent verification or owner acceptance.

The bridge journals the body while offline. After reconciliation it signs a new delivery envelope and
stages its link to that body in the same SQLite transaction before sending. There is only one in-flight
snapshot per run; a later snapshot waits for the preceding durable ACK, while different runs can make
progress independently. A server ACK drains the next queued snapshot and retires the
body only after its durable SQL event has committed. Expired or old-connection envelopes return the
body to pending and are replaced with a fresh connection signature; they are never replayed as a
native start. Uncertain SQL commit responses return no ACK; an exact redelivery recovers the committed
snapshot if it exists. A heartbeat/flush detects an expired outstanding native ACK, closes that transport
and enters the existing bounded reconnect state. The next reconciliation re-signs the pending evidence
on a fresh connection, avoiding reuse or skipping of an uncertain old protocol sequence. There is no
automatic native/provider retry in any of these paths. Correlation references are fixed-length digests.

The node outbox retains at most 2,048 snapshot bodies, including acknowledged records, and flushes at
most 32 per reconciliation/publication/heartbeat opportunity. Central native history is capped at
1,024 observations per run. Capacity fails visibly rather than evicting evidence. A production retention
policy and longer-run capacity rehearsal remain necessary before using this as a continuous fleet.
The bridge journal uses WAL plus FULL synchronization. Disk/commit failures propagate; there is no
claim here that PGlite or an in-process reopen qualifies physical PostgreSQL or process restart.

## Observation semantics

Native snapshot versions may skip: a snapshot is not a replayable event stream. PostgreSQL assigns its
own contiguous event sequence under a run-row lock. Exact duplicate bodies are idempotent; conflicting
versions, identity/handle changes, backward time, reversed stop intent and unreachable states fail.
The adapter journal and central progress validation use the same native-state graph. Terminal evidence
is immutable; a reconnect may directly observe completion, including a completion racing with stop,
without inventing an intermediate running event.

Legacy harness lifecycle ingestion and native snapshot ingestion cannot be mixed. Existing legacy
contracts keep their transition rules. A native run's `startedAt`, if present, means **first observed
execution**, not an inferred upstream start timestamp. A failed preflight has no start timestamp.
Stopping, cancellation or interruption alone do not establish an execution start. `finishedAt` is the local observation time; the upstream update is retained separately. Unknown
transport state maps to disconnected. `cancelState: reported` means Hermes reported cancellation;
it never means that every OS descendant or external effect has ceased.

Usage is the latest upstream snapshot, not a sum of repeated polls and not a local bill meter. Unknown
tokens remain null; reported zero remains zero. Cached/reasoning tokens, call counts and dollars remain
unavailable, and no hard dollar cap is claimed enforceable.

Late observations may be retained for their exact historical lease even after expiry; they do not
renew the lease or resurrect an attempt. This store updates harness **observations only**. It never
changes canonical job/attempt/lease state, inserts an artifact lineage, confirms an effect, approves a
result, enables an agent tool, or marks the owner workflow finished. Those distinctions are required
in the subsequent private task/result interface.

## Acceptance checks

- Exact canonical registration and signed adapter-to-outbox-to-SQL fixture chain.
- Offline persistence, negotiated feature gating, fresh connection signatures, ACK/reconnect recovery.
- Direct terminal snapshots, stop/completion races, no invented starts or cleanup proof.
- Immutable identities, version/time validation, unknown usage and no content/configuration leakage.
- No false ACK after an uncertain SQL response; exact retry adds no duplicate observation.
- Separate legacy regression checks, both compiled application builds and full registered test lifecycle.

No listener, real PostgreSQL, credential store, native agent, provider, deployment or merge is authorized
by this contract or its tests. Full C-WORK and the private-beta exit are not claimed complete.
