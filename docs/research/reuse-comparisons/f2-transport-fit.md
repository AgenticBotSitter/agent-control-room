# F2 actual SDK process transport — synthetic executable only

2026-09-08, baselinefd03365. Extends parser-only evidence to actual published SDK
spawn/stdin/stdout/exit/abort paths crossing current Control Room result projection.
Not native Codex, provider, session custody or complete descendant cancellation.

## Exact implementation and scope

Same published `@openai/codex-sdk@0.153.4` archive and unmodified `dist/index.js`
SHA256 `d62ed107033bdba802b283c77d875e4bec3deb2704a910bb7e3f95059473b16f`, verified
before import. Actual public `Codex`, `startThread` and `resumeThread` select
`CodexExec.run` with explicit `codexPathOverride` pointing only to our tiny synthetic
Node emitter. No installed Codex executable is discovered or started; its package
dependency remains uninstalled. No outputSchema or image path supplied.

The emitter contains no network, agent, credential or child-process functionality.
It records only synthetic argv, environment **names**, input size and temporary PID
for owned cleanup. It writes controlled event/error samples and exits; wait-mode
self-exits within two seconds. Actual SDK uses OS spawn and readline, not a mocked
spawn port. Current `decodeCodexJsonLineV1` and `projectCodexRunResultV1` consume
result events. Existing bounded App Server client is a different protocol option,
not exercised by this exec transport test.

Child env is explicit PATH plus three fixture keys; SDK adds its originator. A synthetic
ambient sentinel is not inherited. macOS added `__CF_USER_TEXT_ENCODING` at runtime;
only its key is observed, never its value. First run's exact four-key assertion
failed on that additional key, with zero checks recorded and cleanup successful.
One correction explicitly permits that platform key while still rejecting any other
key (including the synthetic sentinel). Two subsequent eight-check runs passed.
This does not certify environment inheritance on other platforms.

## Results and integration consequences

| Actual behavior exercised | Observation | Keep or adapt in Control Room |
| --- | --- | --- |
| Public SDK start → spawned synthetic process → stdin/events | Expected exec arguments, directory argument, read-only/network/search/approval settings and final scoped result | Use supported SDK options, but passing flags is not evidence a real runtime enforces them |
| Public resume | Exact known thread ID reaches child argv | Preserve canonical task/attempt/native-ID binding; no real session loaded |
| EOF without terminal | OS process ends normally; application projection refuses incomplete result | Retain terminal validation and uncertainty handling |
| Malformed JSON | Actual SDK parser raises | Catch and sanitize; do not return raw untrusted line to owner logs |
| Nonzero exit | SDK error includes code7 and synthetic stderr | Safe error classification needed |
| Oversized JSON line | SDK yields full line; current decoder rejects beyond its limit | App rejection is after allocation. Need pre-buffer/output cap before claiming memory containment |
| Stderr volume |64KiB test is included in SDK error text; source accumulates stderr chunks | Do not expose raw SDK errors; bounded child-output wrapper or supported upstream cap still needed |
| Abort | Acknowledged cooperative synthetic child receives cancellation and exits; SDK rejects AbortError | No proof for ignored signals, escaped descendants, terminal host cleanup or real native effects |

Eight checks passed; final evidence records399.2ms and parent peakRSS83,120KiB.
Workload is small synthetic processes; parent RSS excludes cumulative child memory.
Neither metric is a production agent footprint or comparison against another SDK.

## Reuse recommendation and remaining decisive comparison

TS SDK remains a strong job-oriented option: supported argument/event transport can
remove duplicated command serialization and stream parsing orchestration. It does
not by itself supply current bounded-output and safe-settlement requirements. Count
the necessary wrapper and dependency/runtime update cost, not just replacing one
constructor. Direct App Server and Python SDK remain viable for interactive state.
No final whole-F2 selection or production file deletion yet.

Do not fork the SDK merely to add ad hoc caps before checking supported options and
comparing existing bounded transport. Native release qualification, approval behavior,
profile isolation, cancellation/cleanup and runtime capabilities remain separately
authorized live gates. The current candidate version does not update our old native
manifest or unlock execution.

## Reproduce and cleanup

`node --import tsx research/reuse-comparisons/f2-transport-fit.mjs /private/tmp/cr-compare-f2.Dz7yHK`
uses the retained hash-checked SDK source from the F2 acquisition ledger. No new
downloads or dependencies. Each attempt creates its own `cr-f2-transport.*` root,
copies the original research emitter, creates an empty directory, waits for recorded
synthetic PIDs to disappear, then removes only that owned root. The final receipt
records `/private/tmp/cr-f2-transport.hsxsX4`, cleanuptrue and zero remaining PIDs;
external absence check also passed. No personal profile, Git worktree or service
was touched. Earlier failed/successful roots were removed by the same finally path.

Independent review requested exact sandbox/search/stdin assertions and distinct PID
traces for initial/resume invocations. Both were added; per-attempt fixture IDs now
prevent trace overwrite. The [corrected eight-check receipt](f2-transport-recheck-evidence.json)
records468.8ms, parentRSS81,888KiB and exact-root cleanup. Prior observations remain
preserved; the improved test supports more precise regression/cleanup coverage.

Actual official documentation was searched and opened this turn:
[SDK](https://learn.chatgpt.com/docs/codex-sdk) and
[App Server](https://learn.chatgpt.com/docs/app-server). Documentation establishes
intended interfaces; actual pinned source/test output establishes these observations.
