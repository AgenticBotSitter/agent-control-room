# CR-5C node-local trust-boundary threat model

**Status:** Complete 2026-08-23
**Worker route:** Hermes / macOS Mac mini / provisional qualification — security documentation analysis packet.
**Purpose:** Threat model for the **node-local containment boundary**: assets, trust boundaries, attacker goals, and required mitigations derived from accepted documents and current source. This is a review artifact — it decides no final policy semantics and claims nothing is fixed.
**Repo state analyzed:** `main` @ `489cd6d`. Every asserted existing control links to a file/line or ADR/doc section.

## 1. Data-flow diagram

```text
                        ┌──────────────────────────── Control Room server (trusted-ish core) ───────────────────────────┐
                        │  PostgreSQL authority · policy decisions · approvals · effect intents · outbox                │
                        └───────┬───────────────────────────────────────────────────────────────────────────┬───────────┘
                                │ signed server→node frames                                                 │ signed node→server frames
                                │ (Ed25519, server trust keys)                                              │ (node identity key)
                                ▼                                                                           ▲
   ┌──────────────────────────────────── THE NODE-LOCAL CONTAINMENT BOUNDARY ─────────────────────────────────────────────┐
   │                                                                                                                       │
   │  Bridge process ── verify/authenticate/replay ──► SQLite journal (commands queue; queueing ≠ permission)              │
   │      ▲                                                                                                                │
   │      │ local ceiling check (CR-5C, absent today) ◄── NodeKeyStore: node private key + server trust bundle             │
   │      ▼                                                                        ▲                                       │
   │  Executor / tool boundary ── effects to destinations ──► artifacts            │ operator (local human)               │
   │      │                                                                        │ emergency pause/revocation           │
   │      └── denial receipts + audit/denial events back through journal/bridge    │                                       │
   └───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Assets inside the boundary: node private key (`NodeKeyStore`, future), server trust bundle, bridge journal (SQLite), queued commands, authority grant/local ceiling, executor/tool credentials-by-reference, artifacts, audit & denial receipts.

## 2. Threat table

Legend: Entry = how the attacker reaches the asset. Owner column names who must build/verify the mitigation. "Existing control" lines cite evidence @ `489cd6d`.

| # | Threat | Entry point | Preconditions | Consequence | Detection | Mitigation owner | Verification class |
|---|---|---|---|---|---|---|---|
| T1 | **Compromised server** issues malicious-but-validly-signed jobs | Signed `job.offer`/`job.lease.grant` frames | Server signing key or server host compromised | Node executes attacker's commands within whatever the node trusts | Impossible centrally by definition — that's the threat | **CR-5C node-local ceilings** per ADR-009 (`docs/CR3_DECISION_LOG.md:106-116`): immutable local maximums, separately protected approval factor | Over-authority tests fail safely (build-plan CR-5C gate); adversarial matrix cases 1,4,7 |
| T2 | Compromised worker process (bridge/executor) | Local code execution on node, same UID | Exploit in bridge/executor, malicious dependency | Attacker holds node key + journal + any in-memory secrets | Host-level anomaly detection only | Out of CR-5C scope beyond blast-radius shaping: typed executors not shell (`ADR-013`), no resolved secrets in journal (`journal.ts:50,136`), single-writer topology (`docs/CR5B_PORTABLE_NODE_BRIDGE.md` §journal). Residual risk accepted at this block | Manual platform validation + secret canary (CR-5Q) |
| T3 | Stolen journal (SQLite file exfiltrated via backup/sync/other process) | Filesystem read of journal path | Journal path readable by another principal; sync tooling copies it | Reveals command history, attempt state, frame bodies — **must reveal no keys/secrets** | None intrinsic | Existing: secret-material guard on every write (`journal.ts:50,136,169`) + redaction patterns (`redaction.ts:3-12`). Gap: guard is pattern-based; journal is unencrypted at rest | Property tests (canary corpus) now; at-rest encryption decision → CR-6A platform packaging |
| T4 | Replay / conflicting replay of captured frames | Network position or stolen frames | Attacker re-sends captured server frames | Duplicate effect execution or replay-conflict DoS | Replay rejection surfaces as `protocol_rejected` status | Existing both ends: durable message-ID+nonce+sequence with exact-retry=duplicate semantics (ADR-022 `docs/CR3_DECISION_LOG.md:262-272`; server `persistence.ts:266-318`; node `journal.ts:190-219`). Effect-side duplicates absorbed by destination idempotency (`executeIdempotent`) | Tested centrally; adversarial case 9 extends to effect boundary — **test only** |
| T5 | Malicious or buggy adapter/executor | Executor implementation itself | A typed executor misimplements an operation or lies about completion | Wrong effects executed or reported succeeded without firing (silent divergence) | Ambiguous-effect attention path if crash detected; otherwise none | CR-5C/D: operation digests bind parameters (`digest.ts:67+`); ambiguity state machine (`state-machines.ts:75-82`); destination receipts required for `confirmed` | Adversarial cases 9b–10c; integration |
| T6 | Local user with filesystem access | Any account/process on the node machine | Not the owner; has user-level read | Reads journal (T3), reads config, potentially triggers local pause themselves | Login audit at most | OS-level isolation out of scope for app code. CR-5C must ensure pause/revocation requires a defined local authority signal, not just any writable file | Decision required (pause mechanism, matrix case 12); manual validation |
| T7 | DNS/TLS routing failure or rebinding | Network path between executor and allowed destination | Allowlist names a hostname; resolver lies mid-session | Effect data delivered to attacker host while nominally compliant | Connection-level cert pinning would catch; none today | CR-5C network guard: pin first resolution / re-verify at connect; scheme+port exact match | Matrix case 5; needs local-DNS integration fixture |
| T8 | Stale/revoked grant still honored locally | Cached authority after revocation | Revocation happens server-side; node offline or ignores it | Work continues past its authorization lifetime | Lease expiry bounds exposure window (leases are time-boxed: `canonical-store.ts:294-297`) | Existing: expiry checked at claim/renewal centrally. CR-5C adds node-local clock clamp (matrix 2a). Open decision: push revocation vs rely on short leases (inventory G4) | Unit (clock clamp); kill-boundary (revoke-during-job rehearsal) |
| T9 | Crash between effect and acknowledgement | Process death in the wrong millisecond | Effect fired externally, local state not yet terminal | Silent duplicate on retry, or lost effect | None if handled dishonestly | Existing primitives: inbox received-vs-processed states (`journal.ts:157-166`), attempt summaries survive restart (`bridge.test.ts:196`), ambiguity transition (`state-machines.ts:77`) | Kill-boundary rehearsals (CR-5Q rig); matrix case 10 defines the three windows |

## 3. Boundary-crossing summary (what must be true at each edge)

| Edge | Inbound | Outbound | Enforced by |
|---|---|---|---|
| Network → bridge | byte ceiling, schema strictness, direction/type ownership, expiry/skew/lifetime, rate limit, digest, secret guard, key/principal state, signature, replay order (`authentication.ts:51-118`) | signed frames only; ack loop prevention (`bridge.ts:235-241`) | existing, symmetric, tested |
| Bridge → journal | secret guard, sequence continuity, content-bound message IDs | durable states for resend/reconcile | existing, tested |
| Journal → executor (**the CR-5C seam**) | *nothing yet* — `recordCommand` is the last stop today (`bridge.ts:163-168`) | *nothing yet* | **to be built**: ceiling check, denial receipts, budget/target/network guards |
| Executor → world | allowlist/canonicalization (absent) | artifacts by manifest reference only (`types.ts:209-225`) | partially central; node side to be built |

## 4. What CR-5C must solve vs later blocks

**CR-5C owns:** local ceiling representation and enforcement at the journal→executor seam; denial receipts; node-local expiry/clamp; network/target guards' policy shape; key-store interface consuming the platform probes (#11–#13).

**Explicitly deferred:** compromised-worker containment depth (T2 — CR-5Q adversarial review + CR-6 platform packaging); journal at-rest encryption choice (T3 — CR-6A); crash-injection automation (T9 — CR-5Q rig); push-revocation vs lease-bounded staleness (T8 — inventory row G4, decision required); secret broker integration (CR-8E per build plan); scheduler/fairness abuse (CR-6C/6Q).

## 5. Residual risks and decisions requiring Codex/owner input

1. **Pattern-based secret guard is bypassable by construction** — novel secret shapes pass `redaction.ts`. Acceptable while journals stay local and un-synced; becomes material the moment backup/sync touches journal files (ties T3).
2. **Server trust rotation has no mechanism** (inventory E8): today's only recovery from a compromised server key is full re-enrollment of every node. Needs either a bundle-refresh protocol or an explicit recorded decision.
3. **Local pause authority definition** (matrix case 12): what counts as the owner's local signal is undecided; getting this wrong converts T6 from nuisance to attack vector.
4. **Single-UID process model**: everything (bridge, journal, executor) shares one OS identity; no defense against T2 beyond code quality. Documented, not solved.
5. **Ambiguity honesty depends on executor honesty** (T5): a buggy adapter that never reports firing cannot trigger the ambiguous path. Destination receipts are the only independent check; their adoption per-operation is a design decision.

## Method note

Derived solely from reading `main` @ `489cd6d`: `src/node-protocol/v1/*`, `src/node-bridge/*`, `src/security/*`, `src/domain/v1/types.ts` + `state-machines.ts`, `src/persistence/canonical-store.ts`, tests, and docs `CR3_DECISION_LOG.md`, `CR3_BUILD_PLAN.md`, `CR5A_NODE_PROTOCOL_AND_IDENTITY.md`, `CR5B_PORTABLE_NODE_BRIDGE.md`. No scans, no live probes, no code changes.
