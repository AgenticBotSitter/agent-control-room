# CR-5C bridge-to-executor insertion-point and lifecycle analysis

**Status:** Complete 2026-08-23
**Worker route:** Johnny5 / Debian 13 VPS / Hermes Agent — static source analysis; medium risk; report-only.
**Repo state analyzed:** `main` @ `489cd6d` (CR-5B complete).
**Purpose:** Trace the current bridge command lifecycle end to end (authenticated inbound frame → journal → future executor), identify crash windows, and propose the smallest backward-compatible CR-5C insertion boundary for validate-before-journal vs validate-before-executor. This report implements nothing.
**Sources read:** `src/node-bridge/bridge.ts`, `src/node-bridge/journal.ts`, `src/node-protocol/v1/authentication.ts`, `tests/node-bridge.test.ts`, `docs/CR5B_PORTABLE_NODE_BRIDGE.md`. All line refs below are against `main` @ `489cd6d`.

## 0. Headline

The smallest safe executor seam is **a single dispatch point inside `PortableNodeBridge.receive()` between command journaling (`recordCommand`, bridge.ts:167) and inbound completion (`markInboundProcessed`, bridge.ts:175)** — realized as one injected interface (`BridgeCommandGate`) called after the frame is durably queued but before the inbox row flips to `processed`. Validation that must *reject* a command belongs there (validate-before-executor); validation that must *reject persistence itself* belongs in the journal's existing guard chain (`stageOutbound`/`recordCommand` secret+digest checks, journal.ts:50/136). Nothing in CR-5B currently consumes `bridge_commands` rows — the queue is write-only today (journal.ts:134–151; confirmed by grep of `tests/node-bridge.test.ts`), so the seam can be added without touching any existing caller.

## 1. Inbound lifecycle sequence (as implemented)

```text
transport.incoming()                     bridge.ts:82   raw bytes from server
  └─ receive(raw, now)                   bridge.ts:115
       ├─ requireConnection()            bridge.ts:116  must have active connectionId
       ├─ authenticator.verify(raw, …)   authentication.ts:51
       │    ├─ size cap                  auth:52–54     reject malformed_frame
       │    ├─ JSON parse                auth:56–61
       │    ├─ version check             auth:63–66
       │    ├─ schema parse              auth:68–70
       │    ├─ connectionId/direction/type allow-list  auth:71–74
       │    ├─ clock skew + lifetime     auth:76–81     reject expired
       │    ├─ rate limit                auth:83–92
       │    ├─ bodyDigest match          auth:93        reject unauthenticated
       │    ├─ secret-material guard     auth:94–98
       │    ├─ trusted-key resolve + key/principal state + validity window  auth:100–106
       │    ├─ Ed25519 signature         auth:107–111
       │    └─ replay.consume()          auth:113–118 → journal.consume() journal.ts:190
       │         ├─ messageId/nonce-digest lookup       journal:195–198
       │         ├─ exact-retry ⇒ "duplicate"           journal:199–204
       │         ├─ else replay conflict throws         journal:203
       │         └─ monotonic per-connection sequence   journal:205–212
       │                                 → {frame, delivery}
       ├─ priorStatus = inboundStatus(frame.messageId)  bridge.ts:132  "received"|"processed"|undefined
       ├─ protocol.ack fast path         bridge.ts:134–139  (dup+processed ⇒ no-op)
       ├─ duplicate + processed ⇒ ack-only  bridge.ts:141–144
       ├─ switch frame.type              bridge.ts:146–174
       │    connection.accepted          → acceptConnection (state checks) :147–150
       │    reconciliation.request      → sendReconciliationReport → online → flushPriorConnections :151–162
       │    job.offer/lease.grant/
       │    lease.renewed/cancel        → journal.recordCommand(frame, now) :163–168   ← COMMAND PATH
       │    protocol.error              → lastSafeErrorCode=protocol_rejected :169–171
       │    default                      → throw :172–173
       ├─ markInboundProcessed(frame.messageId, now)    bridge.ts:175
       └─ sendAcknowledgement(accepted|duplicate)       bridge.ts:176 → sendBody(protocol.ack) :235–241
```

Outbound path (for completeness): `sendBody` → serializeSend queue → build unsigned frame → `signer.sign` (bridge.ts:299) → `journal.stageOutbound` (journal.ts:48; digest + secret-guard + backpressure ceiling + strict next-sequence check, all inside `BEGIN IMMEDIATE`, journal.ts:221–231) → transport.send → `markSent` → optional self-ack for non-tracked frames (bridge.ts:300–310).

## 2. Path/state table

| Phase | Code | Journal writes | State transition | Failure behavior |
|---|---|---|---|---|
| Receive/auth | bridge.ts:115–131 | none yet | — | verify error ⇒ `lastSafeErrorCode=protocol_rejected`, exception propagates to `run()` ⇒ `disconnected()` (bridge.ts:83–87) |
| Replay commit | journal.consume (journal.ts:190–219) | `bridge_sequences`, `bridge_inbox(status='received')` — atomic | delivery accepted/duplicate | conflict ⇒ reject `replayed`; non-monotonic seq ⇒ throw |
| Duplicate short-circuit | bridge.ts:134–144 | none | — | dup+processed ⇒ ack only, never re-handled |
| Accept connection | bridge.ts:147–150, 211–217 | ack causationId | authenticating→reconciling | wrong-state/negotiation error ⇒ throw (inbox stays 'received') |
| Reconcile | bridge.ts:151–162, 219–256 | expireBefore, retireSupersededControlFrames | reconciling→online | flush send failure ⇒ failTransport |
| **Command queue** | bridge.ts:163–168 → journal.recordCommand (journal.ts:134–147) | `bridge_commands(state='queued')` | — | ID-conflict-with-different-content ⇒ throw; duplicate content ⇒ `'duplicate'` (idempotent) |
| Completion | bridge.ts:175 | `bridge_inbox status='processed'` | — | throws if row missing |
| Ack | bridge.ts:176, 235–241 | outbox stage/markSent/self-ack | — | send failure ⇒ failTransport; ack frames not tracked (no ack-of-ack loop, CR5B doc:40) |

## 3. Crash windows (process death between durable writes)

| # | Window | Durable state at death | On retry (same frame redelivered) | Safe? |
|---|---|---|---|---|
| W1 | After `consume()` commit, before handler runs | inbox=`received`, sequences advanced | delivery=`duplicate`, priorStatus≠processed ⇒ falls through switch, handler re-runs | ✅ by design — test at node-bridge.test.ts:329 ("authenticated-but-unprocessed frame is handled on exact retry") |
| W2 | During command handler (future executor), before `markInboundProcessed` | inbox=`received`, command=`queued` | handler re-runs on the duplicate | ⚠️ at-least-once execution — the core reason an executor must be idempotent or gated by attempt/checkpoint state (`bridge_attempts.last_event_sequence`, checkpointIds, journal.ts:168–188) |
| W3 | After `markInboundProcessed`, before ack leaves transport | inbox=`processed`, command=`queued` | delivery=duplicate + processed ⇒ ack(`duplicate`) only, never re-run | ✅ exactly-once handling, at-least-once ack |
| W4 | Command queued but process never restarts cleanly / queue orphaned | command stuck `queued` forever | no consumer exists today | ⚠️ needs reconciliation visibility — unresolvedAttempts covers attempts, NOT queued commands (journal.ts:179–188) |
| W5 | Outbound: signed+staged, death before transport.send | outbox=`pending` | resent on reconnect via pendingOutbound (bridge.ts:247–255) | ✅ at-least-once send |

Duplicate-delivery implication: the protocol gives exactly-once *handling* only when handling and `markInboundProcessed` are atomic from the handler's perspective; today they are two separate steps, so the honest contract is at-least-once with dedupable side effects. Denial-receipt implication: a rejected/denied command must be persisted as an outcome (not merely thrown away) so a redelivered copy gets the same denial receipt instead of re-evaluation under changed local state.

## 4. Insertion-point candidates evaluated

| Candidate | Location | Rejects affect… | Verdict |
|---|---|---|---|
| A. Inside authenticator (pre-replay) | authentication.ts:51 | persistence AND replay record | ❌ wrong layer: policy is node-local, authenticator is protocol-generic; also breaks the received/processed crash-recovery design |
| B. Inside journal.recordCommand | journal.ts:134 | persistence only (validate-before-journal) | ◑ good for hard structural rejects (unknown command type, malformed body) — these already have a home pattern: `assertNoSecretMaterial` at journal.ts:136 |
| C. Between recordCommand and markInboundProcessed | bridge.ts:167↔175 | neither; decides handling (validate-before-executor) | ✅ **recommended seam**: keeps journal purely durable, keeps retry semantics intact (W1/W2/W3 unchanged), matches CR5B doc:70 "queueing is not permission to execute" |
| D. Outside the bridge, consumer pulls queue later | new code post-CR-5C | handling only | ◑ viable v2 (executor daemon), but requires W4 fix first; keep as evolution, not initial seam |

## 5. Smallest backward-compatible seam

One injected constructor dependency on `PortableNodeBridge` (bridge.ts:62–68), defaulted to an allow-all implementation so every existing call site and test compiles unchanged:

```text
interface BridgeCommandGate {
  review(frame: SignedNodeFrame, receipt: {delivery: "accepted"|"duplicate"}): Promise<
    { disposition: "execute" } | { disposition: "deny"; reason: string } | { disposition: "defer"; reason?: string }
  >;
}
```

Call site: in `receive()`, only for the four command types (bridge.ts:163–166), after `recordCommand` returns `queued` (skip gate entirely on `duplicate`), before `markInboundProcessed`:

- `execute` → proceed as today;
- `deny` → persist denial outcome (see §6) then mark processed and ack `accepted`;
- `defer` → leave command `queued`, mark inbox `processed`, ack; command waits for a later pass (covers locked keystore / paused operator states).

Test fixtures needed (all symbolic, mirroring existing style in tests/node-bridge.test.ts): fake gate recording calls; deny-gate asserting denial survives exact-redelivery (W2 variant); defer-gate asserting queued-command retention across close/reopen; gate throwing ⇒ inbox stays `received` and frame is re-offered on retry.

## 6. Open questions this packet does NOT decide (policy, unanswered)

1. Where denials are recorded: no `denied` state exists in `bridge_commands` CHECK constraint (journal.ts:274 allows only queued/handled/rejected) — adding a denial-receipt store is a schema change requiring its own packet decision.
2. Whether `defer` should have a bounded retry count / expiry so commands cannot sit queued indefinitely (W4).
3. Whether gate evaluation must itself be journaled (decision audit trail) — interacts with #30 operator pause dossier and the authority inventory (#14).
4. Whether deny receipts must be reported to the server proactively or only surface on reconciliation (#15 adversarial matrix likely has cases).
5. Ordering guarantee: gates run in inbound arrival order; if authority checks need latest trust state, is per-frame evaluation sufficient?

## 7. Stop boundary

Static source analysis only; no code, tests, migrations, dependencies, live services, secrets, or merges. No files outside `docs/hermes-reviews/` were touched.
