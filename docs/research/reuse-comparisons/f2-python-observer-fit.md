# RC2 actual Python client to native-ID observer

2026-09-08, base0d3031d. **Actual pinned Python client notifications cross the existing CR App Server observer with thread and turn identities intact.** Seven new scenarios demonstrate completion/usage, exact-ID refusal and uncertainty behavior using a fake settlement sink. This is a stronger observer-schema fit than the TS exec stream, but it does **not** resolve the Python client's earlier early-completion ordering gap or choose the whole transport.

OpenAI Docs skill used: searched and opened [official SDK documentation](https://learn.chatgpt.com/docs/codex-sdk), which describes the Python SDK's local App Server protocol and the separate TypeScript job interface. No API/provider operation is involved, so no API credentials are requested. Stagezero ran next and returned ready_for_runtime_check. Current official guidance is interface context, not a claim this pinned source is the latest published SDK or qualified installed runtime.

## Real code, exact adaptation and fake parts

Reacquired the same9 exact source files (404162bytes) from openai/codex commit553df1c691fe8bf7747e50da22f1342984495ae0, with all prior hashes checked before import. This is the selected actual synchronous CodexClient, actual MessageRouter and actual generated Pydantic notification/response models. Minimal package namespaces avoid importing the high-level package facade; origins and exact source inventory are checked. No method AST extraction, fake router or fake generated model. Existing Python3.12.14 and Pydantic2.13.5 used; no package/native runtime install. This is not the full published SDK facade or AsyncCodex qualification.

Public client methods start/initialize/thread_resume/turn_start/next_turn_notification execute over real subprocess pipes to a finite authored Python peer. launch_args_override selects only that peer. Sterile outer Python environment (PATH and PYTHONDONTWRITEBYTECODE) prevents config.env's known inheritance behavior from granting ambient credentials. Synthetic peer contains no command runner, native agent, HTTP or child-spawn action. Any unsolicited server request would be declined, although approval cases are not rerun here.

Peer returns explicit synthetic native thread and turn IDs in real response schemas. After turn_start returns and the actual SDK registers its queue, the fixture sends a synthetic emission trigger. This intentionally controls post-registration ordering; **it does not test or repair the known early-notification/completion gap**. Notification payloads must be actual generated models, never UnknownNotification, and are serialized by supported model_dump(mode=json,by_alias=true) to preserve the App Server's camelCase wire names.

The Node bridge imports actual hash-checked CodexIsolatedTurnObserverV1, binds the turn ID received from the real client, and forwards method/params unchanged apart from that standard serialization. No missing native ID is manufactured. Observer receives an opaque synthetic ticket and fake settlement sink: this establishes observer callback behavior, not broker permission or durable commits. Returned resume ID is compared with requested ID before turn/start; that small research gate mirrors an existing CR requirement but is not an invocation of the whole runtime/controller.

## Actual results

| Scenario | SDK/observer outcome |
| --- | --- |
| Valid explicit resume and notifications | Matching thread/turn; actual observer started→usage→completed. One fake settlement call with17input/8output/5cached/3reasoning |
| Wrong resumed thread ID | Actual typed response exposes mismatch; research gate refuses before turn/start, no observer settlement |
| Wrong thread with same turn | Actual SDK router delivers typed event; actual CR observer rejects start scope and becomes ambiguous |
| Wrong turn | Actual SDK routes events to other turn's queue, none reaches requested queue; finite peerEOF wakes waiter and observer becomes ambiguous |
| Usage after terminal | Actual SDK returns late typed notification; observer rejects already terminal. Earlier completed state and one settlement remain; not a claimed retroactive ambiguity conversion |
| Disconnect before completion | Started/usage received, EOF wakes actual waiter; current observer records ambiguous, no completed settlement |
| Settlement sink throws | Observer reports settlement uncertain and stays ambiguous. Recorded completed then ambiguous entries are **two attempted callbacks**, both throw—not two durable settlements |

All seven scenario assertions passed first execution, no repairs or suppressed failures. Both explicit mismatch and late/error outcomes are expected negative evidence. The SDK does not supply exact-thread authorization by itself, as wrong-thread delivery demonstrates. Correct recovery means more than a successful resume method: this peer has no durable session, so no real restart/recovery is established.

## Why this changes the comparison

TS SDK exec stream from the prior f2-observer packet has no native turn ID and cannot directly satisfy this observer contract. Actual Python/App Server events do, so no new pseudo-native-ID scheme or generic protocol router is needed for this seam. Four usage fields arrive in the format existing observer already understands. The observer and canonical permit/attempt journals remain authoritative; SDK typed response success does not replace them.

However, actual Python client source registers the turn queue after receiving turn/start, and actual router discards buffered events on unregistered completion. The previous deterministic early-completion failure remains decisive and was not rerun unchanged. Native transport/output bounds, parent environment, request deadlines, cancellation/descendant proof and full packaging likewise remain previous open constraints. A second buffering router or fabricated turn ID is not justified merely to claim reuse.

Existing direct CR App Server transport remains a serious alternative: it preserves this same observer protocol without Python packaging, with current bounded frames/request policy; comparison must count its maintained transport burden against a supported client with a tested ordering solution. Python option can potentially replace routing/generated-model/subprocess plumbing, **not** scope checks, ledger, refusal, source/version limits or native cleanup. TS SDK remains viable for an intentionally separate job-only contract, not automatically the current native observer. No app source removed or added.

Narrow rubric0–5: Python observer-schema fit4 (actual scoped completion), integration effort2–3 (bridge, ordering and bounds still needed), custom avoided3–4 (real typed client/router), maintenance3 (pinned source closure; published facade/runtime update path unqualified), resources unknown comparative. Direct-current has lower language-boundary cost, TS exec has the known missing-ID mismatch; these are scoped judgments, not a weighted winner.

Next decisive work: determine and test a supported upstream/client ordering mechanism or upstream fix for completion-before-registration against current direct transport, retaining exact binding and fail-closed uncertainty. Then compare complete bounded transport/interface removal cost. Do not install or qualify native Codex or use past provider authority to close it. Root owns security/protocol selection.

## Evidence levels and resource/cleanup scope

E3 narrowly: real selected Python client+generated models output crosses the actual CR observer, using a fake settlement sink and synthetic App Server peer. The Node bridge replays collected notifications after the Python subprocess exits; it is not an online observer-to-SDK cancellation/lifecycle integration. E2 for specific client transport/routing behavior. Not native Codex, durable database, real authorization, full SDK facade, real resumed session or final RC2 acceptance. Receipt includes actual typed model names/fields, reader closure and7peer reaping; no raw credentials or publisher data.

Each Python experiment has12-second alarm, Node wrapper15-second timeout/2MiB captured-output bound; synthetic peer checks16KiB input lines and emits a fixed small workload. These outer fixture limits are not assertions of SDK preallocation frame/queue bounds. SDK blocking waits still rely on explicit peer closure/outer authority, not a new built-in timeout. No services or heavy databases started while parent's service experiment runs.

139GiB free, other scoped roots579516KiB before acquisition;9pinned files under1MiB, all URLs/hashes retained in f2-python-observer-acquisitions.json. No package scripts or dependency installs, only finite source downloads with15second request bounds. Existing Python/Pydantic distribution was not transitively hash-audited. No comparable RSS/throughput benchmark recorded. Upstream Apache source and eventual Python dependency notices remain separately required, not full legal clearance from root license.

Actual output in f2-python-observer-evidence.json, exit0. All7synthetic peers reaped before completion; exact owned source root then removed and external absence check passed. Parent-owned SDK source and service roots untouched. No app edits, Git/GitHub writes, profiles, credentials or live handles. Independent root review pending.
