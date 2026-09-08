# RC2 Python notification ordering: source decision

2026-09-08. CR baseline `0d3031d`; upstream `openai/codex` immutable revision `553df1c691fe8bf7747e50da22f1342984495ae0`. Source inspection only: no new SDK/native execution, provider, process peer, installation or product change. Root owns protocol selection.

## Finding

Do not dismiss the early-completion finding as an impossible JSON-RPC ordering. The inspected server call path has no response-before-event barrier. More importantly, **even a response-first wire contract would not fix the synchronous Python client race**: delivering its response wakes the requesting thread but does not wait for that thread to register the turn queue. The stdout reader can consume completion first; the actual router deliberately discards an unregistered completed turn's buffered events.

This is an implementation/scheduling inference, not a claim that a real native run reproduced that ordering, or that every fast turn loses events. The prior synthetic negative remains synthetic. No frequency or latency claim follows from these sources.

## Official documentation and immutable call path

Read current [App Server documentation](https://learn.chatgpt.com/docs/app-server) and [SDK documentation](https://learn.chatgpt.com/docs/codex-sdk) before this source trace. They describe request responses and subsequent event streaming; those workflow examples are not a synchronization guarantee for Python threads. Source below is pinned separately from those moving pages.

All source paths below are relative to [the exact upstream revision](https://github.com/openai/codex/tree/553df1c691fe8bf7747e50da22f1342984495ae0). Line numbers refer to that revision, not current main.

1. `codex-rs/app-server/src/message_processor.rs:1515–1523` dispatches `ClientRequest::TurnStart` to the turn processor. Its common response handling is later at1736–1745: successful returned payload → `send_response_as`.
2. `codex-rs/app-server/src/request_processors/turn_processor.rs:167–182` awaits `turn_start_inner`. At638–658 that function awaits `thread.start_or_steer_turn`; at659–667 it extracts the core-generated turn ID. It subsequently awaits config/metadata work (669–686), constructs an in-progress response, and returns at698. No response emission precedes core submission here.
3. `codex-rs/core/src/codex_thread.rs:320–325,460–472` delegates start-or-steer through submission mode to `self.io.submit_turn_input`. This trace stops at that core submission interface; it does not purport to audit the whole inference engine.
4. The already-attached listener runs independently: `request_processors/thread_lifecycle.rs:280–306` spawns a task/select loop receiving `conversation.next_event`;324–359 updates thread state and calls `apply_bespoke_event_handling` for subscribed connections. It does not wait for this turn/start request's response.
5. `bespoke_event_handling.rs:165–193` emits `turn/started`;195–210 handles completion;1408–1431 constructs and sends `turn/completed` with the event's actual turn ID.
6. `outgoing_message.rs:679–717` constructs/enqueues a response. `732–765` separately enqueues notifications on the outgoing sender. FIFO after enqueue is not an ordering barrier between these independently executing producers. The inspected request-serialization queue (`request_serialization.rs:155–211`) orders resource requests; it is not an acknowledgment from Python that turn routing has been registered.

Therefore response-before-completion is **not established by this server path**. Events-before-response are not ruled out by the inspected implementation. Even if an uninspected core/runtime constraint made that particular wire order uncommon or impossible, the client scheduling failure below remains independently relevant.

## Client scheduling: response first is insufficient

`sdk/python/src/openai_codex/client.py:602–622` takes a per-thread start lock, calls `request("turn/start", …)`, then calls `register_turn_notifications(started.turn.id)`. `request` at311–321 validates the response model after `_request_raw`; the latter blocks on a response queue at323–340. The per-thread start lock serializes callers, not the stdout reader.

The sole reader at795–821 continuously reads and routes each message. `_message_router.py:151–174` pops the response waiter and calls `waiter.put(result)`; there is no handoff acknowledgment or turn registration in that method. A legal local schedule is:

1. Reader consumes start response and puts it in the waiter.
2. Requesting thread remains unscheduled, or is validating its model.
3. Reader consumes the turn's notifications and completion.
4. Router finds no registered queue; at207–214 completion deletes its pending deque and returns.
5. Requesting thread finally registers the queue at client621; router89–101 creates an empty queue because the pending deque is gone.

Python's queue wakeup is not a promise that the awakened requester executes registration before the reader's next iteration. No event-before-response assumption is necessary for this schedule. Additionally router registration publishes its queue under lock, then replays its early deque outside that lock (89–101); ordering across that replay boundary needs separate scrutiny before a streaming replacement is accepted. This second observation is source-only, not another claimed failed runtime case.

Upstream tests corroborate the semantics, not native timing: `sdk/python/tests/test_client_rpc_methods.py:245` tests demultiplexing already registered turns; its early-event test ending410–415 exercises buffered replay; `418–442`, `test_turn_notification_router_clears_unregistered_turn_when_completed`, explicitly asserts pending state is empty after early delta plus completion. Those tests were read, not run here. `codex-rs/app-server/tests/suite/v2/turn_start.rs:160–180` is an example that requests a turn and then reads completion through TestAppServer helpers; it does not itself assert the first raw wire frame or impose a Python thread scheduling guarantee. No blanket statement that every upstream test was searched is intended.

## Supported recovery/subscription options

| Existing option | Actual source behavior | Does it close this gap without another router? |
| --- | --- | --- |
| Public `Thread.turn`, `TurnHandle.stream/run` | `api.py:578–610` uses the same client turn_start;741–764 consumes the same registered turn queue. `_run.py:68–99` collects item/usage/completion notifications. | No. Higher-level collection does not reconstruct discarded notifications. |
| Client `wait_for_turn_completed`, `stream_text` | client688–701 and721–748 register/read the same route. | No replay source beyond the existing pending deque. |
| Client `next_notification()` | client349–351 → router global queue; router191–214 sends turn-scoped events to their routes/pending buffer instead. | Not a public raw-all-events tap. It cannot recover the discarded turn stream. |
| Public `Thread.read(include_turns=True)` | api614–616 → client450–455 → supported thread/read. Generated `ThreadReadResponse`10183–10187 contains Thread; Turn9645–9682 carries ID/status/items/timestamps/error, not token usage. | Useful bounded state/result reconciliation candidate. Not exact event replay, not sufficient alone for current observer's usage settlement. Must validate item completeness and exact identity; not manufacture start/usage events from a snapshot. |
| Explicit thread resume | Restores thread association/history; current facade203–235 returns Thread. | Not an automatic physical-turn replay guarantee. In the inspected server lifecycle, resume may send attributed usage after its response (thread_lifecycle763 onward), but that remains a routed notification; it is not an atomic status/result/usage recovery API proven here. |
| Public generic client `request` + generated models | Can access other supported RPCs without rewriting JSON-RPC. | Preserve as an extension seam, but no inspected public RPC returns the complete lost observer stream atomically. Needs specific response/usage proof before selection. |
| Private goal-operation routing | client377–390 describes its thread-scoped logical goal route as private; router121 onward reserves a route before a physical turn. Ordinary turn_start rejects an active goal route at610–614. | Do not repurpose as a public ordinary-turn workaround. It changes ownership/semantics; no new private router justified. |

The synchronous SDK is still a substantive reuse candidate. However, the ordinary turn-stream path at this pin is not ready to replace the current direct bounded App Server transport merely because schema mapping passed. Prefer a supported upstream fix or demonstrated supported reconciliation mechanism over a second custom correlation router or invented IDs. A Python update may eventually fix this; this report does not evaluate another revision or the async client's implementation.

## Effect on earlier evidence and next decision

The seven-case Python observer fixture proves typed-event compatibility **by collecting notifications in Python and replaying them into the actual CR observer after Python exits**. It is not an online CR-observer → SDK cancellation/lifecycle integration; it does not repair early routing or prove durable settlement. Its positive controlled emission happened after queue registration.

Next smallest decisive runtime comparison, if assigned: a synthetic **response-first** peer plus controlled requester scheduling, against the unchanged pinned client, preserving the existing refusal/identity/uncertainty boundaries. Separately test any supported recovery candidate on actual status/items/usage contracts. Do not repeat the old event-before-response baseline unchanged and call that a native defect. Native qualification remains gated. No production component removal is authorized by this report.

## Memory-only public acquisition ledger

Before retrieval, `df -k /private/tmp` showed145,516,808KiB available (>20GiB). No owned download root was created; no source/package bytes were retained on disk. Each raw request used a15-second AbortSignal. Repeated retrievals occurred while narrowing line ranges; table records unique successful source objects, not a measured total network-transfer count. No fetched source was executed. Existing parent-owned roots were untouched; zero new retained bytes require cleanup.

Source URL prefix for every entry: `https://raw.githubusercontent.com/openai/codex/553df1c691fe8bf7747e50da22f1342984495ae0/`.

| Path | Bytes | SHA256 |
| --- | ---: | --- |
| sdk/python/src/openai_codex/client.py |30896|76bdb1e63c62987c3530ea763e9655a06b308cbc4e18cb51958e85b6c23aec3b|
| sdk/python/src/openai_codex/_message_router.py |11855|69a3cca523c833c92bc9c99337399f6f450e45f41822ef3f051c15e0fb9fe7be|
| sdk/python/src/openai_codex/api.py |29066|673defd0ccf1348a86c2bb589cb3a1a69cb315b0a3ecb29525c52f0515a82476|
| sdk/python/src/openai_codex/_run.py |4295|ca0e0c0d9a2c3ae8606cc5986c93bae100c47583df6c4e5643dc5cc582428263|
| sdk/python/src/openai_codex/generated/v2_all.py |326654|03eefef8398b4adc29995d88c04a22b9bb5ee210e3ecfed69fd41aeb2cc72941 (prior identical-pin receipt; current memory retrieval not separately hashed)|
| sdk/python/tests/test_client_rpc_methods.py |15262|da00c06caafe56db3718dfdf06e3253f420d0c9a7cc7c4e4c82c0e462c86a65a|
| codex-rs/app-server/src/message_processor.rs |73931|9a5d37d0a63ac4f475a56151d73ecb8b97602b6405c2513240726c87e850df8e|
| codex-rs/app-server/src/request_processors.rs |34649|6b7957a7e0b0535bffe300d917a410e866f2744b4f586fb1be824d7197f87bcc|
| codex-rs/app-server/src/request_processors/turn_processor.rs |65870|a220c6f21bd72d7135d772536b414b1d7fbd7c1c332b2103f0029a3b22c5f7f1|
| codex-rs/app-server/src/request_processors/thread_lifecycle.rs |33700|2c7c8e10662e509cfc735f320ef46070ba544046130303a5c755a071fd638384|
| codex-rs/app-server/src/bespoke_event_handling.rs |163004|c633d68e02ac0a366f296edacd347d1bbc193716b7bb6a3ffbebae843c9ffba5|
| codex-rs/app-server/src/outgoing_message.rs |57837|3a16ce7e44cc937cd3e6eb86a961e72b429d8afa25ee7a102f70b8b5cdb6d2c8|
| codex-rs/app-server/src/request_serialization.rs |33294|afad58b53d6a8ce410efc85c26551ffd7ed3475448265bef9ecaa39454388fac|
| codex-rs/app-server/tests/suite/v2/turn_start.rs |196933|60115a392ec501c04a2b220f5c2b47ac2b0fad2358216effbe7407971a8624b8|
| codex-rs/core/src/codex_thread.rs |36629|9431fae40d866b456f55a2e817e3e4edc715705c340e8cf8b2bbdf25b2606038|

Failed path probes (HTTP404,14-byte body, no source): `codex-rs/app-server/src/codex_message_processor.rs`, `sdk/python/src/openai_codex/_app_server.py`, `sdk/python/src/openai_codex/app_server.py`. Their identical body hash is `d5558cd419c8d46bdc958064cb97f963d1ea793866414c025906ec15033512ed`. Narrow GitHub contents metadata listings located the real paths: app-server/src, app-server/src/request_processors, app-server/tests/suite/v2, sdk/python/tests, sdk/python/src/openai_codex, all with the exact ref above. Metadata was not retained or executed. No whole repository download, credentials, providers, service, GitHub write, or installed dependency.
