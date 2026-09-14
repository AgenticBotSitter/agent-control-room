# Codex recovered-result runtime

Issue #173. Module: `src/harness/codex-v1/recovered-result-runtime.ts` (exported
from `src/node-bridge/private-node-entry.ts`).
Tests: `tests/codex-recovered-result-runtime.test.ts` (9 tests reusing the
`codex-result-sender` live-bridge fixture pattern).

## What it is

One reusable runtime that returns a single completed, exact Codex result through
the already-authenticated live node connection and the existing canonical server
result path. The outer long-lived node owner opens the bridge journal and start
journal once, authenticates the connection and retains them through
child-process recovery; the runtime only borrows them and never opens, closes or
recreates either journal or another bridge.

## Borrowed vs owned

- Borrowed: bridge journal reads (`acceptedCodexActivation`, `codexResultReturn`),
  start journal read (`load`), live bridge send op (`sendCodexResultReturn`),
  negotiated channel currency (`assertCurrent` + `connectionId`).
- Owned: one recovery read host (`createCodexReadRecovery` shape: `project`),
  one `createCodexResultSenderV1` holding the single send slot.

## Flow

Before the native read and after it, the runtime requires exact run/queue/thread/
turn/activation IDs and digests across both journals, the current negotiated
result-return channel bound to the activation connection, no existing return for
the run, and current local read authority. Only then it projects through the
owned host, requires completed status plus an exact package result, captures
observed time and invokes exactly one `sendRecovered`. The returned transport
receipt is verified against the journal (run, activation, prepared-frame digest)
before it is handed back.

## Dispositions (all errors sanitized, `codex_recovered_result_*`)

| Situation | Outcome |
| --- | --- |
| Stored receipt exists | return stored receipt, no read/send |
| Prepared or sent exists | `delivery_uncertain`, never read/send again |
| Missing/summary/secret/malformed/noncompleted | `observed`, bounded, no sender |
| Send error, then receipted | return stored receipt |
| Send error, then prepared/sent | `delivery_uncertain` |
| Send error, no durable return | `unavailable`, no automatic retry |
| Journal unreadable after send error | `cleanup_uncertain` |
| Altered receipt | `receipt_invalid`, fail closed |

A transport receipt means only received by the server: no quality acceptance,
task completion, capacity release or merge permission. `close()` is idempotent;
`cleanupDoubt` stays true on every path because the projection never verifies
cleanup. Cross-connection replay/reactivation is out of scope and refuses.

## Limitations (honest)

- Tests use a synthetic live bridge plus stubbed start reads; no real provider,
  installation, authentication, credential, listener or deployment is exercised.
  Real provider/installation proof remains #61/#68.
- The standalone `run-private-node` recovery launcher stays nonpublishing; the
  VPS launcher test pins that behavior.
