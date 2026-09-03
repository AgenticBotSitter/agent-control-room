# CR13A-LIVE-080 private-loopback listener lifecycle acceptance

**Status:** exact remediation `884ff423914ab4e442500bd194970b0713da72ca` independently accepted after
closing one Medium and two Low findings; ordinary owner-controlled integration remains
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
before it can become lifecycle evidence. Immediately after validation, the lifecycle retains only the frame digest,
byte count, and chunk count needed for the receipt; it never stores the complete protected frame. Every terminal failure
and explicit abort clears those reduced facts plus transient timing evidence.

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

Frozen deterministic evidence:

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

Intermediate commit `c98ae8128195469d2789357df31ada18b32480e3` was superseded before reviewer dispatch when
architect self-review added explicit canonicalization/hash runtime custody. It was never presented as independent-review
evidence. The rejected implementation code is `7333ea48577b1000fd5eac0e6789b3e21cfeb559`. The exact remediation is
`884ff423914ab4e442500bd194970b0713da72ca`.

## Review and next boundary

Because this contract defines the lifecycle immediately around future network input, the exact product must be frozen
and reviewed by a fresh independent reviewer. The review must reproduce deterministic gates and probe strict plan and
receipt parsing, behavioral inputs, identity drift, frame provenance, ordering, capacity, time bounds, terminal states,
cleanup, public-safe output, recomputed negative claims, and absence of listener/network/runtime enablement. A rejection
or uncertainty remains negative evidence and requires remediation plus a different re-review.

The zero-repair packet is `docs/reviews/CR13A_LIVE_080_INDEPENDENT_REVIEW_PACKET.md`, SHA-256
`00c005a2371f20dc4de66685659f9fde7a0bd6513627829fd7894ace0451f4a0`.

The independent reviewer reproduced every deterministic count and confirmed the no-effect boundary, but rejected the
target. Medium M-001 shows that premature `finish` or a wrong-order call after frame acceptance can leave the protected
raw frame retained in the terminal object. Low L-001 shows that receipt parsing omits the plan's 160-character listener
ID ceiling. Low L-002 shows that a caller can change `rehearsalReference`, recompute the public digest, and rebind the
receipt away from the reference derived from `planDigest`.

The negative report is preserved at `docs/reviews/CR13A_LIVE_080_INDEPENDENT_REVIEW.md`, SHA-256
`0f43e735ce30fe418dd93a4d5221497dde25b9f3c50d95c501f1322064bc7688`. Exact remediation
`884ff423914ab4e442500bd194970b0713da72ca` closes M-001 by retaining only reduced frame evidence and clearing all
evidence on every terminal path. It closes L-001 by enforcing the receipt listener-ID bound of 27–160 characters. It
closes L-002 by deriving and comparing the rehearsal reference from the validated plan digest. Regressions cover both
frame-bearing terminal paths, recomputed semantic drift, and the exact listener-ID boundaries. A different independent
reviewer must now reproduce closure without repairing the product.

The immutable zero-repair re-review packet is
`docs/reviews/CR13A_LIVE_080_REMEDIATION_REREVIEW_PACKET.md`, SHA-256
`a65f0be8d60cc5bcfdbc2f60ecea3e6c2e055594b79a738419245817f0d72271`.

The different reviewer independently reproduced every deterministic gate and hostile-probe family, closed M-001,
L-001, and L-002, and found no new High, Medium, or Low defect. The unchanged accepted report is
`docs/reviews/CR13A_LIVE_080_REMEDIATION_REREVIEW.md`, SHA-256
`3e5ea006098cf51222e62296e5cb80b924b4da5dab0d319e188e4073a3d5b6f1`.

Independent acceptance permits ordinary owner-controlled integration only. It does not authorize the next native
block. A future physical listener requires separate exact owner authority and must prove real exclusive loopback bind,
SSH-tunnel peer authentication, host-key custody, native backpressure/timeouts, one-frame delivery into LIVE-060,
shutdown, cleanup, ambiguity handling, and safe rolling-update behavior.
