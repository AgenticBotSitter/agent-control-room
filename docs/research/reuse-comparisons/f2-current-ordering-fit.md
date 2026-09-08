# RC2 current runtime: matching early-turn experiment

2026-09-08, baseline `0d3031d`. Research only; current application/test sources unchanged.

## Decision-changing result

The actual `CodexIsolatedQualificationRuntimeV1` refuses a **matching** early turn start, not only a stale turn. Both same-turn schedules become `app_server_protocol_invalid`, with an ambiguous entry in the actual in-memory broker ledger. No result or usage is recovered; a repeat request does not issue another thread/start or turn/start. This is safe refusal, **not successful support for legitimate pre-response events** and not full transport acceptance.

| Synthetic frame schedule | Actual result | Same-request replay |
| --- | --- | --- |
| Response → start → usage → completion (eager control) | completed; usage20 input/4 output/8 cached/2 reasoning | replay_completed |
| Matching start → response → usage → completion | protocol refusal; ambiguous ledger | ambiguous; no new thread/turn |
| Matching start → usage → completion → response | same refusal at first start; later three frames unread | ambiguous; no new thread/turn |
| Stale start → response → matching stream (negative control) | protocol refusal; ambiguous ledger | ambiguous; no new thread/turn |

Four scenarios, each with a second runtime instance and transport sharing its in-memory ledger for replay. Every first attempt contains exactly one synthetic turn/start. Each ledger's consumedProviderCalls remains1 after replay; these are bookkeeping counters, not real provider calls. Eight transport instances receive one close call each. Replay still performs initialize/environment setup; it does not create a new thread or turn. This is same-process ledger reuse, not persistent restart evidence.

The all-events-first scenario does **not** prove handling of early usage/completion: the runtime rejects the first start before reading those frames. The receipt retains queued and consumed frame distinctions. The successful eager control queues all frames synchronously during write, so its outcome is consistent with the sequential response binding in the current runtime. It does not exercise a concurrent reader implementation.

## Fidelity and limits

Standalone fixture `research/reuse-comparisons/f2-current-ordering-fit.ts` imports the actual runtime, controller, observer, credential permit issuer, launcher planner and InMemoryCodexCredentialBrokerLedgerV1. Before importing, it checks exact SHA256 for isolated-runtime.ts, isolated-jsonrpc.ts and credential-broker.ts (receipt includes pins). Other transitive local dependencies use the unchanged checkout; no full-closure hash claim.

Fixture references existing `tests/codex-harness-contract.test.ts` helper shapes (source SHA256 `039936f5de047c6b3486f7d37b27213ee6b5fe08c17b862f76132951d3967d23`) without importing or modifying the test suite. The only protocol peer is an authored finite line transport. Authority evidence, IDs, clock, environment readiness and launcher paths are synthetic. The launcher is only planned: no referenced paths or endpoint are opened. There is no native Codex, provider, real credential, OS child/stream, SQLite file, DB, network listener or persistent service.

Runtime timeout is1000ms per invocation. Authored transport checks outbound line size<16384bytes and fewer than10 writes, and emits a finite four/five-frame turn corpus. It never intentionally blocks. These fixture limits do not establish an underlying production transport's resource bounds. Close is an actual runtime→fake-port call, not proof of OS process-tree termination. The process exited normally; no live process handle or owned temporary directory exists.

Stage zero passed `ready_for_runtime_check` against app lock SHA256 `3d98f907941fa407b82b4af1e9475acb2f93f92a427cea666edeb652ad92a8c8`. Existing prepared Node/tsx used, no downloads or installs. First run exit0; an identical second run captured stdout directly into `f2-current-ordering-evidence.json`. No fixture repair or failed result erased. No app tests, app sources, root disposition or shared progress files changed.

## Selection consequence

E3 narrowly for composed current runtime/controller/observer/in-memory ledger behavior through a fake transport. Not upstream/native compatibility, durable settlement, final connector acceptance or proof that current upstream environment methods match this qualification fixture.

Together with `f2-python-ordering-source.md`, this rules out a misleading choice: neither blanket early-event refusal nor the pinned Python pending-event loss closes the full ordering responsibility. Keep exact identity, ambiguous settlement, no-repeat and bounded close requirements. A supported upstream client correction or explicitly qualified reconciliation path must address this responsibility; no custom buffer/router is introduced here. Root owns security changes and final selection.
