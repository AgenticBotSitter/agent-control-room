# CR-5C execution-time authority expiry state-machine proposal

**Work packet:** #44 (`[WORK][CR-5C] execution-time authority expiry state-machine proposal`)
**Worker route:** Ziggy / Windows PC (RIG1) / Hermes Agent desktop — model route `stealth/ox-alpha` via Nous (differs from the ceiling-dossier route per packet note)
**Task class:** Documentation-only; high-risk design analysis. No source, tests, migrations, config, or live timing experiments.
**Repo state analyzed:** `main` @ `489cd6d` + merged CR-5C report set.
**Purpose:** Close contradiction-review **F2** (S1) — three reports gave three answers about which clock decides execution-time expiry — and **F6** (S2) — offline revocation honesty. This document proposes candidate state machines; it decides nothing. Every claim cites a seam; assumptions are labeled `[assumption]`; proposals `[P]`.

**Primary citations:**
- **[CR]** = `CR5C_RESEARCH_CONTRADICTION_REVIEW.md` (F2, F6)
- **[ATX]** = `CR5C_ADVERSARIAL_TEST_MATRIX.md` (cases 2a/2b/9/10)
- **[LCY]** = `CR5C_BRIDGE_EXECUTOR_BOUNDARY_ANALYSIS.md` (#29)
- **[OPTS]** = `CR5C_LOCAL_POLICY_CONTRACT_OPTIONS.md` (#28)
- **[OPS]** = `CR5C_PLATFORM_OPERATIONAL_MATRIX.md` (#31)
- **[5B]** = `docs/CR5B_PORTABLE_NODE_BRIDGE.md`; **[SM]** = `src/domain/v1/state-machines.ts`

---

## 0. The F2 resolution this proposal implements

F2's finding: "node's own clock" was used for two different things — (a) an injected deterministic clock at *evaluation* time and (b) real wall-clock *monitoring* between evaluations. A pure-function gate never re-checks a lease that expires mid-run unless something calls it again [CR F2].

**Resolution adopted here (candidate):** split the obligation exactly as CR proposes —

- **B-2a Evaluation-time clamp**: pure function of (authority, request, injected `Clock`). Property-testable. Decides admit/refuse at a point in time.
- **B-2b Mid-execution re-check obligation**: a separate, explicitly-owned runtime component whose sole job is to notice wall-clock crossings (`expiresAt`, lease renewal boundaries, revocation notices) while an effect is in flight and drive the state machine's expiry transitions.

The executor wrapper owns B-2b. Nothing else in the current seam list does [inference from OPTS Option A's pure-evaluator shape + bridge.ts tick() ownership]. This split is itself Decision D-44-A for Codex (§7).

## 1. States

Node-local authority lifecycle for one accepted effect (job/attempt scoped). Names chosen to align with existing vocabulary where it exists ([SM] attemptTransitions/effectIntentTransitions, [5B] lifecycle):

| State | Meaning | Existing analog |
|---|---|---|
| `QUEUED` | Signed command verified+queued by bridge; policy not yet evaluated ("queueing is not permission" [5B]) | inbox `received` [5B journal] |
| `ADMITTED` | B-2a clamp passed against injected clock; capacity/reservation made; awaiting executor start | attempt `leased` [SM] |
| `EXECUTING` | Effect wrapper running; B-2b monitor armed | attempt `running`, intent `executing` [SM] |
| `EXPIRING_SOON` | Monitor computed time-to-expiry below threshold; no action yet beyond notification | *(new)* |
| `EXPIRED` | Authority window crossed; wrapper must stop starting new sub-effects | lease `expired` [SM terminal] |
| `CANCELLATION_REQUESTED` | Server/operator cancel received mid-run; draining | job `cancelled` path [SM] |
| `AMBIGUOUS` | Crash/restart/expiry landed in a window where the external world may have been affected | intent `ambiguous` [SM], ATX 10b |
| `TERMINAL_OK` / `TERMINAL_FAILED` / `TERMINAL_CANCELLED` | Settled outcomes with receipts journaled | attempt terminals [SM] |

### Transition diagram

```text
                    ┌────────────────────────────────────────────┐
                    │            (crash at any arrow)             │
                    ▼                                             │
QUEUED ──admit──▶ ADMITTED ──start──▶ EXECUTING ──done(ok)──▶ TERMINAL_OK
   │                 │                    │    ──done(fail)─▶ TERMINAL_FAILED
   │refuse(B-2a)     │cancel              │                     ▲
   ▼                 ▼                    │──expire-cross────▶ EXPIRED
 DENIED(receipt) CANCELLATION_REQUESTED ◀─┘──cancel-recv───────┐   │
                   │                    │                      │   ├─▶ AMBIGUOUS?
                   │drain-ok            │◀──renew(grant)───────┼───┘
                   ▼                    │       [P] renewal re-arms
              TERMINAL_CANCELLED        │
                                        │──crash/restart w/
                                        │   in-flight effect
                                        ▼
                                   AMBIGUOUS ──dest-receipt──▶ TERMINAL_OK/FAILED
                                      │──no evidence+policy──▶ TERMINAL_FAILED
```

Rules every arrow must satisfy:

1. **Idempotent transitions.** Every transition keyed on `(attemptId, transitionName, observedAtEpoch)` tuple in the journal; replaying the same event is a no-op, not a double move. Mirrors the durable message/nonce replay discipline [5B ack semantics; journal replay identity].
2. **EXPIRED is locally authoritative.** Crossing `expiresAt` moves EXECUTING→EXPIRED without consulting the server [ATX 2a invariant]. But see §4 honesty bound: the server learns only when connectivity next exists.
3. **EXPIRING_SOON is advisory only.** It may trigger checkpointing or renewal *requests*; it must never authorize anything that plain ADMITTED wouldn't. Prevents "expiring-soon" becoming a shadow authority level.
4. **No transition skips ambiguity.** Any crash/restart discovered with a possibly-fired external effect lands in AMBIGUOUS first (ATX 10b); settling requires destination receipt evidence (10c).
5. **Terminal states accept nothing** except journal replays (idempotent no-ops).

## 2. Clock responsibilities: injected-test-clock vs runtime timer

| Concern | Owner | Clock kind | Testability |
|---|---|---|---|
| B-2a admit/refuse decision | Local policy evaluator [OPTS Option A] | Injected `Clock` (deterministic). Function reads zero wall-clocks internally. | Property tests: arbitrary (authority, request, now) triples ⇒ decision+receipt; monotonicity properties |
| Lease/`EXPIRING_SOON` boundary computation | Executor wrapper's monitor | Runtime timer armed at ADMITTED with `firesAt = min(expiresAt, leaseExpiresAt)` | Unit: inject fake timer; assert firing order vs expiry set |
| Mid-run expiry crossing (B-2b) | Same monitor | Wall clock via OS; *also* re-derived from injected clock on every state write so journal records are deterministic | Kill-boundary seeds (ATX 10 class) |
| Renewal request timing | Monitor, at EXPIRING_SOON entry | Wall clock | Unit with fake timer |
| Backoff after failures | Bridge core (existing) [5B deterministic backoff] | Existing tick()-based | Already tested [5B verification list] |

Key design rule **[P]**: the monitor never *decides* — it only *emits events* (`ExpiryCrossed`, `ExpiringSoon`, `RenewalWindowOpened`) into the same idempotent transition machinery. Decisions stay in pure functions fed by those events. This keeps the F2 split clean: timers have owners, decisions have purity.

Timer-vs-timer hazard **[assumption]**: OS timer coalescing can delay firing past the true crossing instant. Consequence: the recorded `observedAtEpoch` may be later than `expiresAt`. The state machine treats *any* observation of `now > expiresAt` as expiry regardless of how late the observation was (fail closed), and journals the lateness delta for audit.

## 3. Lease vs authority expiry ordering

Two distinct expiries exist and can disagree:

- **Lease expiry** (`LeaseGrantBody.expiresAt` [protocol types]) — server-granted execution window.
- **Authority expiry** (`AuthorityEnvelope.expiresAt` [domain types]) — the delegation ceiling's own deadline, bound server-side by parentDigest chain [domain authority].

**Ordering rule [P]:** effective deadline = `min(authority.expiresAt, lease.expiresAt)`, computed at ADMITTED and recomputed on every renewal grant. Rationale: neither grant can extend the other; a renewal extends only its own term, never the envelope's (delegation narrowing-only [domain authority compare rules]). If a renewed lease outlives the envelope, the envelope still clamps — EXPIRED fires on schedule.

Conflict cases:

| Case | Behavior |
|---|---|
| Lease renewed, envelope unchanged | Effective deadline stays envelope-bounded; renewal only prevents lease-side expiry |
| Envelope superseded mid-run (new digest via re-issued offer) | Out of scope for v1: mid-attempt authority swap is not representable in current frames [assumption from protocol frame set]; treated as cancellation-requested + fresh attempt if needed. Flagged D-44-B |
| Clock skew makes node believe expired, server disagrees | Node fails closed locally (ATX 2a); server observes attempt failure/expiry event on next contact; no extension negotiated inside the executor path |

## 4. Offline behavior — stated honestly (F6 companion)

What the node CAN do offline:
- Enforce its own expiries (§3) — purely local information.
- Refuse new work when keystore unavailable [OPS §2.2].
- Detect trust-bundle staleness *age-wise* (bundle carries fetch time [assumption — bundle format owns this]).

What the node CANNOT do offline:
- Learn of server-initiated revocation. There is no push channel; revocation propagates only at next authenticated contact [CR F6; persistence delivers keys at enrollment today]. **Offline revocation is therefore NOT instantaneous and this document claims it never will be without a new mechanism** — satisfying the packet's acceptance requirement head-on.
- Extend anything. All offline paths fail toward *less* authority, never more.

**Maximum revocation-propagation delay [P]**: define `revocationDelayBound = reconnect backoff ceiling (60s [5B]) × k + reconciliation latency`, with `k` and measurement owned by Codex as **D-44-C**. Every offline-trust claim elsewhere must cite this bound rather than implying immediacy (implements CR F6's proposed correction).

During disconnection the machine keeps running states normally; all outbound receipts/events queue as unacked durable frames [5B durability] and flush on reconnect. An EXPIRED-while-offline attempt settles locally as TERMINAL_FAILED with `authority_expired_local`; the server reconciles the truth later — the two may briefly disagree about *why*, never about *what was observable*.

## 5. Grace policy options (Decision D-44-D)

For effects already in flight when expiry crosses:

| Option | Semantics | Pros | Cons |
|---|---|---|---|
| G0 Hard stop | Wrapper aborts effect at crossing | Simplest; strongest ceiling | External side-effects may be half-applied ⇒ more AMBIGUOUS outcomes |
| G1 Checkpoint grace | Fixed short grace (e.g., until next checkpoint, bounded ≤ N seconds [N open]) to reach a safe stop point | Fewer ambiguous tails; respects destination transactionality where it exists | Grace consumes post-expiry time ⇒ ceiling breached by design; needs its own receipt code |
| G2 Destination-dependent | Grace only for destinations that declared transactional/idempotent behavior | Precise; uses existing retryPolicy.ambiguousEffectPolicy signals [domain types] | Requires destination capability metadata that doesn't exist yet [assumption] |

Candidate default: **G0 for v1**, G1 as config-gated evolution once destinations carry transactional metadata (D-44-E). Any grace used MUST produce a distinct receipt code (`authority_expired_in_grace`) so audit can distinguish hard-stop compliance from grace usage.

## 6. Receipts, crash recovery, and the external-effect proof

### Denial / ambiguity receipts in this machine

| Transition | Receipt/event code (safe vocabulary) | Carries |
|---|---|---|
| QUEUED→DENIED (B-2a refuse) | `policy_denied_local` (+ detail per [OPTS] vocabulary, node-private) | digests only |
| ADMITTED→…→EXPIRED→TERMINAL_FAILED | `authority_expired_local` [ATX 2a naming] | attemptId, digests, observedAt, latenessDelta |
| EXPIRED within grace (G1) | `authority_expired_in_grace` | as above + graceUsedSeconds bucketed |
| Cancellation honored | `cancelled_by_request` | requestId of cancel frame |
| Crash → AMBIGUOUS raised | `effect_ambiguity_raised` [ATX 10b] | lastCheckpointId?, effectRefDigest |
| AMBIGUOUS settled ok/fail | `effect_settled_confirmed` / `effect_settled_failed` | destinationReceiptDigest |

All receipts follow the privacy dossier constraints [#47 dossier; ATX case 11]: safe codes, digests, no free text, secret-guard pass [`redaction.ts:38-41`].

### Crash recovery mapping (windows per ATX 10)

| Crash window | Journal state found at restart | Recovery action |
|---|---|---|
| Pre-admit | QUEUED row only | Re-run B-2a against recovered clock; proceed or deny |
| Post-admit/pre-effect | ADMITTED row, no effect-proof row | Safe to re-admit (nothing fired) [ATX 10a] |
| **Post-effect/pre-settle** | EXECUTING row, effect-proof row present, no terminal | → AMBIGUOUS; settle only with destination evidence [ATX 10b/c] |

The **effect-proof row** is the linchpin (next section).

### What an executor must prove before an external effect [P]

Before any externally-visible action, the wrapper must atomically persist a **pre-effect proof** containing:

1. `attemptId` + `transitionTarget = EXECUTING` (already-journaled admission),
2. `effectIntentDigest` — canonical digest of the exact outbound action (target canonical form, operation, argument digest),
3. `authorityDigestAtFire` + `effectiveDeadlineAtFire`,
4. `proofWrittenAt` (injected-clock value, also wall-clock stamped).

Write ordering guarantee: proof row commits **before** the effect fires, in the same WAL-commit discipline as sequence/outbox commitment [5B "atomic sequence/outbox commitment"]. On restart, the presence of a proof row without a terminal row is *the* signal for AMBIGUOUS (never silent re-fire). Absence of a proof row means the effect provably did not fire through this node — restart may re-authorize [ATX 10a].

Additionally, before firing, the executor must re-assert three cheap invariants (the "**pre-fire triple**"):

- keystore still `available` [OPS availability gate],
- `now(injected) <= effectiveDeadline` (fresh B-2a call — the last-instant clamp),
- effectIntentDigest matches what was admitted (detects drift between queue and fire).

Failure of any ⇒ transition to the appropriate denial/expiry path instead of firing. This triple is what makes "executor proves authority at fire time" concrete and testable.

## 7. Decisions Codex must make (none decided here)

| ID | Decision | Options | Tests that depend on it |
|---|---|---|---|
| D-44-A | Adopt B-2a/B-2b split with executor-owned monitor | Adopt / alternative owner (bridge tick) | Timer-ordering unit tests' injection seam |
| D-44-B | Mid-attempt authority swap representation | Out-of-scope v1 (current) / new frame type v2 | None until protocol v2 |
| D-44-C | Define `k` + measure reconciliation latency for `revocationDelayBound` | Values/budget | Offline-trust rehearsal assertions |
| D-44-D | Grace policy | G0/G1/G2 (§5) | Expiry-boundary property tests' expected receipt |
| D-44-E | Destination transactional metadata prerequisite for G2 | Defer to CR-7 adapter contracts | G2 tests (blocked until then) |
| D-44-F | EXPIRING_SOON threshold ownership (server-sent hint vs local constant) | Either; local default | Expiring-soon unit test parameterization |

## 8. Test catalogue per decision/state (property/unit/kill-boundary)

| Test | Class | Asserts |
|---|---|---|
| P-1 Admit clamp totality | property | For all (ceiling, authority, request, now): total decision, no throw, receipt on deny |
| P-2 Monotonicity | property | Later `now` never converts a denial into an admission (time only tightens) |
| P-3 Min-deadline dominance | property | Effective deadline = min(lease, envelope) for arbitrary pairs; renewal cannot exceed envelope bound |
| P-4 Idempotent replay | property | Applying any transition event twice yields identical journal state |
| U-1 Timer firing order | unit (fake timer) | EXPIRING_SOON precedes EXPIRED; both fire once |
| U-2 Late-observation lateness | unit | Observation after true crossing still yields EXPIRED + latenessDelta journaled |
| U-3 Pre-fire triple refusal | unit | Keystore lost / clock passed / digest drift each block the fire independently |
| U-4 Offline expiry settles locally | unit | Disconnected expiry → TERMINAL_FAILED + queued receipt, no server wait |
| K-1 Kill in each ATX-10 window | kill-boundary seed | Restart classification matches §6 table; ambiguous never silently re-fires |
| K-2 Reconnect reconciliation | kill-boundary | Queued receipts flush exactly-once after reconnect [5B replay semantics] |

## Assumptions ledger

- Timer coalescing lateness exists on real OSes [assumption; harmless under fail-closed rule §2].
- Mid-attempt authority swap isn't representable in current frames [assumption from frame union; verify at implementation time].
- Trust bundles will eventually carry fetch-time/staleness fields [assumption; D5 territory [SYN §7]].
- Destination capability metadata absent today [assumption; blocks G2].

## Stop boundary

Read-only analysis; no source/tests/migrations/config touched; no live timing experiments run; allowed path = this file only. No final architecture selected — §7 lists what Codex owns.

`git diff --check`: clean at commit time.
