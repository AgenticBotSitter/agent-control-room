# RC2 async SDK and read recovery: source decision

2026-09-08. Source-only follow-up at upstream `openai/codex` revision `553df1c691fe8bf7747e50da22f1342984495ae0`. No SDK, native process, provider, test, installation, service or credential operation was performed. This is E1 evidence, not a new executed fit or final selection.

## Decision-changing finding

**The async Python client is not a different transport implementation.** `sdk/python/src/openai_codex/async_client.py:52–76` constructs the synchronous `CodexClient` and delegates blocking operations with `asyncio.to_thread`. Consequently switching to async at this pin does not remove the already documented early-completion routing gap. Testing async as though it were an independent router would repeat the same implementation comparison.

The strongest supported recovery seam found is exact-thread `thread/read(includeTurns=true)` for stored turn status/items, with exact returned turn-ID matching. It is not complete usage recovery or event replay. Preserve that option for a narrowly scoped reconciliation experiment; do not manufacture observer events or settlement from the snapshot.

## Actual async lifecycle and routing

All paths below are relative to the pinned repository; hashes and retrieval counts are in `f2-async-recovery-source-receipt.json`.

| Interface | Actual implementation | Consequence |
| --- | --- | --- |
| Async start/close | `async_client.py:88–94` delegates both to sync methods. | No separately managed async reader or reconnect loop. |
| Async turn start | `async_client.py:284–291` delegates the entire synchronous `turn_start`. Sync `client.py:620–621` requests and validates the response before registering its queue. | Same independent stdout-reader scheduling gap as the previous report, not eliminated by event-loop offloading. |
| Registration and notifications | Async100–114 delegates registration directly;336–346 offloads next-notification calls. `_message_router.py:207–214` discards pending events on unregistered completion. | Not a new raw-event tap; registered/unregistered semantics remain unchanged. |
| Async generic request | Async124–137 delegates typed request. | Useful access to supported RPCs, not an independently implemented recovery protocol. |
| Async cancellation | Ordinary `_call_sync` has no turn-interrupt/cleanup handler. Explicit `turn_interrupt`293–295 remains available. Logical-goal start236–282 has specialized cancellation cleanup. | Do not claim cancelling an ordinary await interrupts the native turn, and do not repurpose goal routing as ordinary-turn recovery. No cancellation runtime test here. |
| Sync process start | `client.py:238–272` starts stdio app-server, copies ambient environment then applies config overrides, starts stderr/stdout threads. | Async does not improve environment isolation. Future execution must retain sterile outer-process controls already used in previous research. |
| Sync close | `client.py:274–291` closes stdin, terminates, waits2seconds, kills on exception, then joins reader/stderr with0.5second bounds. Reader803–821 routes until failure then calls router `fail_all`. | Shutdown mechanism exists; no automatic reconnect/resume/re-registration is supplied by this path. Kill branch lacks a second explicit wait here; no claim of verified OS cleanup from source alone. |

Read—not run—`sdk/python/tests/test_async_client_behavior.py`. Its two tests establish intended offloading concurrency and forwarding of notification registration semantics through substituted sync methods. They are not tests of real reader ordering, reconnect, native cancellation, or replay. This makes the wrapper conclusion stronger without claiming those tests passed in this task.

## Read recovery versus replay

Official [App Server documentation](https://learn.chatgpt.com/docs/app-server), fetched using OpenAI Docs, distinguishes stored `thread/read` from subscribing/resuming. Current documentation also mentions experimental `thread/turns/list`; that is a pagination possibility, not evidence of a complete per-turn usage API at the pinned revision.

- Sync `client.py:450–455` sends the caller's exact `threadId` plus `includeTurns`; async181–183 forwards it. Generated `ThreadReadResponse:10183–10187` contains a Thread. Generated `Turn:9645–9682` has actual ID, status, items, itemsView, timestamps and error. Its fields do **not** include token usage. `itemsView` explicitly distinguishes the loaded item scope; a future fit cannot blindly assume a complete result.
- `ThreadTokenUsageUpdatedNotification:8590–8596` contains threadId, turnId and tokenUsage. Its `last`/`total` breakdown is a notification model, not a field on the Turn snapshot. Account-wide usage is not interchangeable with this attributed per-turn evidence.
- The actual server resume path is a stronger complementary option than only reading: `request_processors/thread_lifecycle.rs:663–667` derives an optional usage-attribution turn ID from cold-resume state or included history;763–778 sends the resume response, then conditionally emits usage to that connection. Connection association occurs692–701. This is an effectful subscription/resume path, **not** the same read-only operation as thread/read.
- That usage emission is conditional and attributed to the server-selected restored turn, not a caller-selected arbitrary historical turn. These inspected ranges do not establish a full historical usage lookup, atomic snapshot+usage result, or correctness of the deeper attribution helper. If the required exact thread/turn IDs are already known, public registration before a separately authorized resume could avoid registering late for that known turn; this is a testable candidate, not a proven solution. It does not repair initial unknown-ID start acknowledgment loss, and a different attributed turn must remain unusable for the original settlement.
- No supported `turn/read` endpoint or complete exact-turn status/items/usage read was established by the inspected source and documentation. This is a scoped absence of evidence, not an exhaustive claim about every current or future endpoint.

## Strongest realistic choices and next smallest experiment

1. **Existing direct bounded App Server transport:** retain as incumbent comparison and current safety boundary. Prior synthetic early-event refusal/ambiguous settlement is safe negative evidence, not successful recovery. A supported exact-ID read can be compared through that transport without adding a second correlation router.
2. **Public synchronous SDK plus supported reconciliation:** still a credible typed-client reuse candidate. The async facade adds Python integration convenience, not stronger routing. Compare actual `thread/read` against an exact recorded thread/turn, including wrong identity, absent turn, non-full items, active/failed/completed states. Keep usage unresolved unless actual matching evidence exists.
3. **Known-ID registered resume plus attributed usage:** narrower but stronger potential completion of reconciliation; requires independent review of the attribution helper and an authorized synthetic interface experiment. Verify no new turn submission, reject usage for another turn, and retain uncertainty on absent usage. This task does not authorize resuming a real thread or changing CR settlement rules.

Do not add a custom router or invented ID to make a candidate pass. Do not repeat async-wrapper mounting as a new independent candidate. Root retains authority to choose the next bounded experiment and whether existing contracts permit snapshot reconciliation. Production component deletion remains unapproved.

## Acquisition and cleanup

Prior Python source roots were already absent. Twelve bounded public HTTP responses were read in memory:542,121 response-body bytes total, including repeated exact source reads and one14-byte404 probe. Each request had a15second deadline and streamed body cap (100,000bytes inventory/tests;500,000 or1,000,000bytes per multi-file invocation). Combined measured bodies stayed below3MiB. No source bytes, packages or temporary directory were retained; only this report and metadata receipt were written. No cleanup of another agent's files was performed. Official documentation retrieval is tool-managed and not included in that raw-source response-body count.
