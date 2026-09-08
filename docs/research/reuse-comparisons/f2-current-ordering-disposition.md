# RC2 current transport ordering: root disposition

2026-09-08; inspected local source at `0d3031d`, with uncommitted research only.
Source-level comparison, not a new native or synthetic execution receipt.

## Decision-changing finding

The current direct qualification runtime is **not a demonstrated solution to all
early-event ordering**. Do not reject the Python SDK and declare the existing
transport complete on the strength of its fail-closed checks.

`src/harness/codex-v1/isolated-runtime.ts` distinguishes two cases:

- At lines 59–73, the sequential request driver reads one frame at a time. It
  returns on the matching response. At lines 203–206, the runtime extracts and
  binds that response's turn ID before asking the transport for another frame.
  Consequently it has no Python-style independent reader/router registration
  window at this layer for response-first frames. This is a source property of
  this class, not proof of every underlying transport's losslessness.
- At lines 199–202, **every** notification during `turn/start` is rejected with
  `app_server_protocol_invalid`; the callback does not inspect whether it belongs
  to the turn subsequently named in the response. Catch handling disconnects the
  observer and records ambiguity rather than retrying or declaring success.
  A matching legitimate early event is therefore not supported either.

The actual upstream source trace in
[Python ordering analysis](f2-python-ordering-source.md) does not establish a
response-before-event server barrier. It is therefore insufficient to call our
blanket early-event rejection only a stale-event defense. The trace is an inference
about possible scheduling, not a measured native failure rate.

## Existing test evidence, read rather than rerun

`tests/codex-harness-contract.test.ts` contains the actual runtime fixture:

- `ScriptedAppServerTransport` queues a response and then the complete start/usage/
  completion sequence synchronously in `write`. The ordinary completion test
  verifies lifecycle, counters, closed transport and replay disposition. This is
  already a useful eager response-first baseline; do not duplicate it as new work.
- Its `stale` mode inserts a **different turn's** start before the response and the
  failure/interruption test asserts protocol refusal. It does not discriminate a
  same-turn legitimate early start/completion from that stale case.
- Existing ambiguous, deadline and cancellation cases protect uncertainty. Those
  protections must remain regardless of the selected upstream client.

These tests were inspected in this pass, not executed. This report does not assign
new pass counts to them, nor assert the qualification class is the complete
production connector or today's upstream environment API contract.

## Bounded selection consequence

| Ordering | Current direct qualification runtime | Pinned synchronous Python SDK |
| --- | --- | --- |
| Response, followed immediately by events | Sequential bind-before-next-read in source; existing scripted baseline | Independent reader may finish before requester registration; source trace and upstream router semantics identify a separate race |
| Same-turn event before response | Blanket protocol refusal, not successful recovery | Prior synthetic completion-before-registration case loses buffered turn events |
| Stale/unrelated early event | Refusal is intentional | Routing alone is not CR identity/authority enforcement |

Neither candidate is selected for the full lifecycle by this table. The existing
runtime has a concrete reason to retain its sequential binding and uncertainty
boundaries while evaluation continues, **not** permission to expand bespoke
infrastructure or a claim that no upstream solution exists.

The [actual current-runtime fixture](f2-current-ordering-fit.md) now supplies the
missing same-turn early-event case: two early schedules are refused at the first
start frame, record ambiguity in the actual in-memory ledger and issue no second
turn on same-request replay. Eager response-first and stale controls separate
successful ordering from intentional refusal. Root read the complete standalone
fixture and direct receipt: accepted for that narrow runtime/ledger composition.
The author disclosed a second identical run to retain stdout; it adds no distinct
coverage. No further unchanged replay is needed. Persistent restart and real
transport termination are not established by this fake-port/in-memory experiment.

Still exercise response-first reader/requester scheduling through the unchanged
Python client, if that remains decision-changing. Compare bounded
termination, exact identity, usage availability, durable settlement/reconciliation
and no duplicate start. Keep stale-event cases separate. Investigate supported
upstream correction/reconciliation before proposing a new correlation router.
Do not synthesize lost usage or manufacture native IDs from thread snapshots.

The [independent source review](f2-current-ordering-review.md) agrees with this
distinction and preserves best-effort settlement and qualification-versus-production
limits. Its source review preceded the new runtime fixture and is not represented
as independent execution review of those new results.

## Other evidence accepted narrowly

Root read the independent [Python observer review](f2-python-observer-review.md):
accepted as offline generated-model-to-observer composition, not online lifecycle
or durable settlement. Root also read the independent
[OpenBao review](f5-openbao-service-review.md): accepted as bounded E2 observations,
not adapter/custody selection. Preserve its full-payload assertion, early-setup
cleanup, recreation-absence and historical-reconstruction limitations for the next
adapter packet. No unchanged service rerun is required to accept those observations.

No application edits, credential access, downloads, service starts, GitHub writes
or native calls were performed in this disposition.
