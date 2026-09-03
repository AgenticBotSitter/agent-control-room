# CR13A-LIVE-080 private-loopback listener lifecycle acceptance

**Status:** local implementation candidate awaiting immutable freeze and independent review
**Integration base:** `b0b129824f99dbaeb86f7cc6eac4001530fbe1fa`
**Effect boundary:** repository code and local tests only; no socket bind, listener, SSH session, credential access,
Hermes/provider call, native process, production PostgreSQL/VPS contact, deployment, DNS, or other network effect

## Delivered boundary

`ConnectionEnrollmentPrivateLoopbackListenerRehearsalV1` defines the exact lifecycle that a future private listener
must satisfy before its already-decoded frame can cross the accepted CR13A-LIVE-070 framing boundary. This block is a
repository-fake rehearsal, not a physical listener. It imports no networking or process-launch module, opens no port,
starts no tunnel, reads no credential, and changes no local-pilot runtime wiring.

The digest-bound plan fixes:

- `transport: "ssh_tunnel"`, `listenerVisibility: "private_loopback"`, IPv4, and literal `127.0.0.1`;
- the accepted single-frame framing contract and bounded frame/chunk ceilings;
- endpoint, owner, tunnel-peer, tunnel-host-key, and channel identities as digests only;
- exactly one active connection and zero queued connections;
- bounded total connection lifetime, idle timeout, and shutdown grace period;
- exactly one frame per connection; and
- no automatic restart after shutdown or ambiguity.

Plan values are strict ordinary data. Extra keys, accessors, Proxies, aliases, invalid digests, out-of-range ceilings,
and stale digest-bound mutations fail closed without invoking caller behavior. The plan is public policy and therefore
does not use its unkeyed digest as authenticity or authority proof.

Before each plan or receipt digest boundary, the lifecycle reuses the accepted enrollment-ingress runtime-custody check.
Post-import replacement of a selected canonicalization, reflection, pattern, typed-array, or hash operation fails with a
bounded local code before the changed behavior executes.

## Six-step lifecycle

The rehearsal accepts exactly six ordered repository-fake observations:

1. the simulated bind matches literal IPv4 loopback plus endpoint and owner identity digests;
2. exactly one connection opens with zero queued work and matching tunnel-peer, host-key, and channel digests;
3. one LIVE-070 decoder-minted protected frame arrives within the chunk, connection, and idle ceilings;
4. that connection closes with no active or queued work and monotonic connection age;
5. draining starts within the shutdown deadline with automatic restart disabled; and
6. simulated cleanup completes within the shutdown deadline, after drain began, with no remaining work.

Every observation must carry the plan digest, listener identity, exact sequence, `repository_fake` evidence mode, and
`nativeEvidenceAccepted: false`. Invalid data, ordering, capacity, lifetime, frame provenance, identity, or cleanup makes
the instance terminal. A successful finish also becomes terminal: it cannot emit a second receipt or accept later
observations. Abort clears the protected frame and terminates the rehearsal.

The lifecycle accepts only the exact module-private protected frame minted by LIVE-070 and requires the same listener
identity and frame ceiling. A clone, a caller-recomputed digest, or a valid frame minted for a different listener fails
before it can become lifecycle evidence. The raw frame remains in private memory only until the receipt is constructed,
then the lifecycle releases its reference.

## Receipt truth and authority

The strict, digest-bound public receipt contains only the listener/plan reference, frame digest, byte and chunk counts, bounded
capacity facts, and policy-match booleans. It never contains the raw frame, delivery ID, signature, bind address, host
identity, username, credential, or tunnel material.

Every passing receipt explicitly records that actual bind, exclusive port ownership, tunnel-peer authentication,
host-key custody, and native cleanup were **not** proven. It also records that the listener remains disabled, no network
I/O occurred, and no approval, network, command, lease, or execution authority was granted. Those negative facts are
fixed contract literals; changing one remains invalid even when a caller recomputes the public receipt digest.

This receipt proves only that the repository-fake state machine enforced the planned ordering and limits. It cannot be
used as native readiness, physical bind, tunnel, enrollment, connection, deployment, or production evidence.

## Deterministic evidence

Current pre-freeze evidence:

- macOS stage zero: pass (`ready_for_runtime_check`), with no native attempt;
- TypeScript: pass;
- full ESLint: pass;
- focused lifecycle/framing/admission suite: 34/34 pass;
- complete connection slice: 76/76 pass;
- complete repository lifecycle: 769/769 pretests, 419/421 core tests with two intentional platform skips, and
  327/327 posttests;
- production build and 4/4 rendered-route checks: pass;
- PostgreSQL migrations `0001` through `0036`: pass with 119 tables; and
- whitespace validation: pass.

## Review and next boundary

Because this contract defines the lifecycle immediately around future network input, the exact product must be frozen
and reviewed by a fresh independent reviewer. The review must reproduce deterministic gates and probe strict plan and
receipt parsing, behavioral inputs, identity drift, frame provenance, ordering, capacity, time bounds, terminal states,
cleanup, public-safe output, recomputed negative claims, and absence of listener/network/runtime enablement. A rejection
or uncertainty remains negative evidence and requires remediation plus a different re-review.

Independent acceptance would permit ordinary owner-controlled integration only. It would not authorize the next native
block. A future physical listener requires separate exact owner authority and must prove real exclusive loopback bind,
SSH-tunnel peer authentication, host-key custody, native backpressure/timeouts, one-frame delivery into LIVE-060,
shutdown, cleanup, ambiguity handling, and safe rolling-update behavior.
