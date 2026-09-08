# RC6 local update primitives: what exists and what does not

2026-09-08; baseline8352d3e. **14 focused tests passed.** Actual persistent-journal,
launcher and connector primitives preserve uncertainty and refuse unsupported journal
schema. **There is no executed immutable-release updater or continuous fleet-drain
implementation here.** This bounded test does not manufacture one to close RC6.

## Actual source and executed boundary

Stage zero returned ready_for_runtime_check. Exact commands/counts are in
`f6-update-evidence.json` (condensed direct-terminal receipt).

`research/reuse-comparisons/f6-update-fit.test.ts` imports the actual
`src/harness/hermes-native-v1/run-journal.ts::SqliteNativeRunJournal`. One private
state directory stays outside two inert working directories named release-a/release-b.
Three short-lived Node children sequentially use the **same current implementation**:
first reserve an existing synthetic fixture binding and persist dispatching; reopen
from the other directory; reopen from the original directory. Both later reservations
return created=false and preserve attempt/state. The database SHA256 is unchanged.
This proves directory-independent persistence and no renewed local reservation,
**not** compatibility between two software versions or a release pointer switch.

Second test creates a private synthetic journal through the actual API, closes it,
then changes only PRAGMA user_version to2 through SQLite. Current constructor refuses
with native_journal_unavailable and leaves the file hash unchanged. This proves the
current schema guard rejects a future schema. It is not an application-level rollback
policy, data migration, compatibility manifest or recovery from a failed upgrade.

Both tests passed (467.6ms total runner duration). Each inert child is bounded15s and
256KiB output. The fixture has no provider port; its zero providerCalls field is a
declared inert test characteristic, not evidence of instrumentation around a real
native start. No extracted/installed release, fake production updater or new security
rule was added. Cleanup hooks remove exact owned temporary roots and assert absence.

## Existing stop and uncertainty behavior exercised, not reimplemented

A filtered run of `tests/private-node-launcher.test.mjs` and
`tests/native-connector-denials.test.ts` passed12 tests in137.3ms:

- Initial/recover compose once and close connector/runtime before caller resources.
- Bounded, ambiguous and failed work do not report completion or trigger retry.
- Recover mode polls only after recorded dispatch and never invokes start.
- HTTP uncertainty does not retry or invent native cleanup.
- Overlapping run is refused; caller abort drains current owned objects.
- Nonsettling close remains uncertain and is memoized rather than repeated.
- Launcher SIGTERM path retains resources when injected drain fails.

Fidelity: launcher code is actual `scripts/run-private-node.mjs`; release/operator/
connector objects are injected fixture implementations, and SIGTERM is an EventEmitter
event, not an installed-service signal. Connector code is actual
`src/node-bridge/native-connector.ts` and its HTTP host, with synthetic peer/runtime
ports and mock timers in deadline cases. These are useful local policy/ordering
checks; no actual provider shutdown, OS process-tree containment, persistent fleet
drain, service stop/restart or target-platform lifecycle is proven.

## Missing implementation, exactly

The launcher imports a fixed relative `../dist-vps/server/nodeConnector.js` and runs
one explicit initial/recover task for at most300seconds. Connector `attempted` permits
one run, bounded cycles, close/drain of owned runtime/host, and uncertainty returns.
There is no continuous eligible-pickup service or version-selection/updater API in
these entrypoints. A supervisor restart of the initial command is not recovery.

`src/node-service-packaging/v1/conformance.ts` requires NON-INSTALLABLE historical
templates and forbids substituting the one-task launcher or restart policies.
`diagnostics.ts` returns continuous_service_not_available even with valid supplied
paths/runtime. Existing F6 conformance4/4 evidence remains relevant; it was not
repeated here. Neither journal constructor nor conformance supplies release signing,
version overlap/compatibility negotiation, approved switch, drain-before-switch,
readiness rollback or exclusive runtime ownership across competing service instances.

The actual native journal uses DELETE/FULL with schema version1 and private-file
checks. `src/node-bridge/journal.ts` is a distinct complementary bridge journal with
its own frame/attempt semantics; its WAL behavior is not attributed to the native
journal. This fixture does not combine or replace the two journal responsibilities.

## Reuse versus custom scope

Retain native supervisors for process lifetime: existing VPS supervisor/systemd in
the correct namespace; macOS personal LaunchAgent/Aqua; Windows personal interactive
Task Scheduler; WinSW as a distinct dedicated-account service candidate. A personal
authenticated profile does not become a dedicated unattended account just because
a service template exists. Previous WinSW/Task Scheduler evidence remains E1 and
requires target-platform inert acceptance; none is upgraded by this Mac test.

Do not build a custom replacement for systemd/launchd/SCM. The missing CR-specific
adapter must coordinate accepted pickup/drain, journals/uncertainty and schema/release
compatibility **around** the chosen supervisor. Reuse existing close/recover/journal
primitives instead of a new retry loop or store. Root must design the missing runtime
contract and check upstream updater patterns before custom implementation. No source
selection for a generic updater is earned by these tests.

Current production deletion:0. Existing primitives demonstrably avoid a new journal
and duplicate one-shot cleanup mechanism. Estimated integration effort remains
unknown until continuous runtime and compatibility interfaces are defined; no fake
weighted selection or measured service footprint. Native-supervisor lifetime fit4–5
(source evidence), current whole-update coverage1–2 (only primitives), measured native
restart/resource cost unknown. Scores are scoped judgments, not readiness grades.

## Next acceptance, without a lookalike updater

1. Implement/reuse an actual continuous connector boundary and expose accepted drain:
   stop new eligible pickup, settle or retain the current attempt, refuse automatic
   resubmission after ambiguous start, and keep journals outside release directories.
2. Exercise that real implementation using inert worker/state with two **actual**
   versioned releases and explicit compatibility data. Test failed startup, readiness
   failure, interrupted switch, incompatible schema, restore/rollback and ambiguous
   pending attempt. Same-source cwd changes do not satisfy this gate.
3. Only after that, target-qualified native supervisor tests under the correct personal
   or dedicated identity: logout/sleep/reboot, duplicate trigger, stop/forced-kill and
   child containment. No native credentials or installation is authorized by this report.

RC6 therefore remains open for the actual continuous/update implementation and target
qualification. The local evidence narrows which existing primitives can be reused;
it does not turn absent infrastructure into an accepted feature.
