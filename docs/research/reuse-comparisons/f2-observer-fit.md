# RC2 SDK observer, result and explicit-ID recovery boundary

2026-09-08, base8352d3e. **The real supported TS SDK stream reaches the existing CR result/usage mapper, but cannot directly supply the current App Server observer's native thread+turn contract.** Preserve identity binding, terminal/transport precedence and uncertainty handling rather than treating SDK stream completion as authoritative settlement. This is a bounded comparison, not a production bug report or final whole-RC2 selection.

OpenAI Docs skill was read; official SDK guidance was searched and opened before substantive interface investigation (stagezero had been run alongside initial skill read). [Official SDK documentation](https://learn.chatgpt.com/docs/codex-sdk) describes job automation and explicit resumeThread; App Server is the custom-client route. Documentation establishes interface intent, not the capabilities of the old pinned native runtime. No API key operation is applicable: no API-backed app/provider/runtime is called, only an explicitly synthetic local peer.

## Exact actual versus synthetic components

Reuse retained published `@openai/codex-sdk@0.153.4` at `/private/tmp/cr-compare-f2.Dz7yHK/package/dist/index.js`, SHA256 `d62ed107033bdba802b283c77d875e4bec3deb2704a910bb7e3f95059473b16f` checked before importing public `Codex`. No new download/install; source belongs to earlier logged cohort and remains untouched. SDK native dependency is not installed or run. Actual public resumeThread/runStreamed uses actual spawn/readline/JSON parsing with `codexPathOverride` pointing only at the copied finite synthetic emitter. Args reach exact requested explicit thread ID; child env is explicitly supplied, no personal profiles or credentials. There is no real restored session or durable recovery proof.

Actual `decoder.ts`, `result.ts`, `isolated-jsonrpc.ts` hashes checked before dynamic imports. Existing decoder maps SDK event objects to scoped CR events, then actual projector computes result. A separate actual `CodexIsolatedTurnObserverV1` consumes the candidate's real returned event shapes under a deliberately naive method/params envelope to expose protocol fit. It receives an opaque synthetic ticket and a **fake settlement sink**, not a broker-authorized claim or durable ledger. Sink records classifications only. No manufactured native turn ID, renamed contract, generic router or application change makes the mismatch disappear.

Seven new scenarios execute once each; prior unchanged8/15-check cohorts were not rerun. No fixture repair. SDK errors are retained only for known synthetic peer text; this is not permission to log actual untrusted error contents.

Evidence level: E3 narrowly for actual SDK synthetic transport crossing unchanged CR decoder/result functions; E2 plus concrete failed-fit evidence for the observer comparison, not successful E3 settlement. Native runtime, durable recovery and ledger authority are not exercised.

## Findings

| Scenario | Actual observation | Integration consequence |
| --- | --- | --- |
| Explicit-ID resume plus full usage | Exact requested UUID sent, returned ID matches; result succeeds with17input/8output/5cached/3reasoning | Job-oriented result seam works. SDK also reports4cache-write tokens, absent from current CR usage contract; do not call the four existing fields complete provider accounting |
| Peer announces another thread after resume | SDK replaces its ID with different valid UUID; CR result mapper still succeeds because it validates CR tenant/run scope, not native-ID binding | Existing runtime/controller explicit-ID checks must remain outside result projection; SDK forwarding is not recovery-identity validation |
| Agent message after terminal | SDK yields it; decoder returns a new final digest but no event; composed research projection succeeds with digest of the late answer | A boundary guard must decide terminality before updating side-channel digest. Do not assume projector's event-after-terminal rule covers digest-only frames |
| Usage terminal after terminal | Actual projector rejects events after terminal | Existing authoritative terminal checks remain useful |
| Failed event with synthetic attached usage | SDK streamed object retains extra usage, decoder emits failure; result counters0 | SDK's declared failed-event schema does not promise a usage field. This synthetic extension demonstrates that current mapper does not read it; do not infer failed native calls cost0 or call this a dropped guaranteed SDK field |
| Terminal event then nonzero peer exit | SDK rejects code7; separately projecting accumulated frames still yields succeeded | Wrapper must honor transport error/uncertainty; partial-frame success projection is deliberately unsafe composition in this harness, not an identified production caller behavior |
| EOF without terminal | SDK stream ends; current projector refuses missing terminal | Keep refusal/reconciliation; no blind replay of an uncertain provider attempt |

The wrong-thread and late-digest findings likewise describe this research bridge's limitations, not proof that current production dispatch lacks its existing checks. Actual runtime `isolated-runtime.ts:178` checks resumed identity; controller checks request/native equality. The projector's scoped run ID cannot replace those checks.

## Observer incompatibility, not a fabricated adapter success

SDK0.153.4 declared ThreadStartedEvent includes thread_id; TurnStartedEvent includes only type; TurnCompletedEvent includes usage, not native turn ID. Actual stream contains no native turn identifier. Existing observer requires bindTurn(actual native ID), matching threadId/turn.id on start/completion and matching turnId on usage. Its usage schema also expects tokenUsage.last's camelCase counters. Passing dotted SDK type names is ignored; renaming turn.started to turn/started alone rejects start because binding and scoped shape are absent. Each test disconnects that observer and records ambiguous into the fake sink. No successful observer settlement is claimed.

This is an exact semantic/schema mismatch rather than criticism that two different protocols use different names. A small field mapper could rename counters, but cannot honestly recover a native turn ID absent from this stream. Root must select an intentionally different exec-attempt accounting contract or prefer App Server/Python SDK where thread+turn IDs are available. Do not invent a fake native ID to pass the existing observer, and do not delete settlement/recovery authority as duplicated SDK functionality.

Actual SDK source runStreamedInternal lines86–91 overwrites thread ID and yields parsed events; run lines99–125 uses last completed message/final usage and throws on failed turn. CR decoder emits usage only on turn.completed; agent-message digest is a side return with no event. Result projector detects late events, not a digest's time of arrival. Observer source171–263 requires binding, validates usage progression/terminal and records ambiguity on disconnected/uncertain settlement. Prior pinned upstream SDK tests/source-map acquisition remains in f2-codex-interfaces.md; no native upstream tests run here.

## Comparative cost and next decisive gap

TS SDK still offers supported Node job start/resume/argv/stream handling and would avoid duplicating that machinery. To use it safely requires a thin owned boundary for output/error limits (prior evidence), exact native thread binding, unknown/late frame handling, final-digest closure, transport-success precedence, permit/attempt accounting and recovery reconciliation. Some are existing CR requirements, not generic SDK features. No production file deletion is earned by these7cases. Retain decoder/result tests, native authorization/cleanup, journals and current observer for its App Server responsibility.

Direct App Server preserves the present native thread+turn observer model and existing bounded transport but maintains more custom protocol/session code. Actual Python SDK comparison is already viable for App Server routing; it has a language/process boundary and separate runtime/dependency distribution cost. Do not dismiss it merely because TS matches app language. Keep-current is a viable low-migration alternative; minimal new mapper cannot solve missing native identity without a deliberate changed boundary. No new generic router or app contract alteration was authored.

Narrow judgments0–5: TS SDK exec result fit3–4, current observer fit1; integration effort2–3 once bounds/terminal/recovery counted; custom avoided3 for argv/stream not authority; maintenance3 with pinned update tests; measured resource score unknown comparative. Direct/Python observer fit potentially higher but not retested in this packet. No weighted universal winner.

Next decisive step: root compare actual Python/App Server observer binding and settlement (including explicit recovery and late/uncertain notifications) against these exact native-ID/accounting requirements, then select job exec versus App Server responsibility. If TS remains selected for a job-only contract, test an approved minimal boundary rather than removing security to match the SDK. Native/protocol-version qualification is separate exact authority, not unlocked by this synthetic run.

## Evidence, storage and cleanup

`f2-observer-evidence.json` is direct parsed stdout, exit0,7scenarios with negative outcomes preserved. Stagezero ready; disk139GiB free before test. Downloads0, installs0. Prior184KiB SDK source cohort retained untouched; package archive/provenance/Apache notice/native dependency exclusions are in f2-acquisitions.md. No whole release license clearance inferred.

One disposable peer root contains only copied authored emitter, empty directory and synthetic per-mode argv/PID traces. All7peer PIDs observed absent using signal0 after terminal streams, then exactroot removed; cleantrue and remainingCount0 in receipt, external absence check succeeded. No descendant tree is claimed: emitter has no child-spawn functionality. Four-second AbortSignal guards each call but ignored-signal descendants remain prior unqualified scope. Parent peakRSS77664KiB excludes child total and is not a native agent footprint. No persistent services, livehandles, app/Git/GitHub changes. Root review required.
