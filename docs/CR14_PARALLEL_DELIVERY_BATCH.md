# CR14 parallel delivery batch

Date: 2026-09-05. Base: `eee200a4760281e2bb1f06c6af4c1d5182eaf07e` (PR #324).
Product: `673380625f537de0d893c0f736f3eeab6ea37ef8`.
Tree: `3381822cd22e035d080f3c4463b5ff2073939713`.
Final test-fixture correction: `33bc7a421319c04aa962d3cdde45a57108107fed`, tree
`bea8eb04d47b73f0f6a905581eb07d4abf7429be`; production implementation unchanged.

Final verification exited zero: CR14C551, preparation770, main1135 with two existing platform skips,
post-suite392; both builds, private compiled18, rendered4, migrations0052/138 tables, TypeScript and
ESLint. Draft-capsule retirement validation passed4. Current-head CI remains required before integration.

The owner explicitly resumed building with Codex coordinating parallel internal subagents. This is
not an external GitHub draft-capsule claim or authority to install the fleet. Separate local worktrees
isolated contributions. No agent merged or published its own output; root reviewed and integrated it.
No deployment, live provider/native call, credential operation or usage-reset redemption occurred.

## Delivered scope

- Sol High implemented the frozen deterministic ABS digest policy: freshness, score, archive/verification,
  cluster deduplication, canonical-source diversity, stable ordering, conflicting IDs and no input mutation.
  Root connected it to the existing integrity-checked local news store as a read-only selection method.
  This does not add live collection, a second global queue or PostgreSQL-backed ABS application mounting.
- Astra High built a cross-module regression through actual canonical planning/assignment/approval,
  signed delivery/intake, local admission/effect markers, native adapter, canonical progress, result bytes,
  planned review target and owner quality review. Keys/transport/profile evidence remain synthetic.
- Sol Medium wrote [the three-host preparation guides](fleet-setup/README.md). These explain the exact
  candidate/version prerequisite and distinguish checkout preparation, installation prerequisites,
  evidence produced by installation and later live acceptance. They are not production installers.
- Root implemented authenticated progress routing on the existing delivered-task server session. A
  separate Astra High reviewer checked that production change and the database precommit correction.

## Progress route contract

`ServerNodeSession.acceptNativeSnapshot` requires a persisted recorded (not rejected) delivery and
negotiated snapshot support. It authenticates one current node/connection frame within the negotiated
limit capped at16KiB, matches project/job/attempt/binding against the delivered task, and rejects future
observation times. The trusted callback persists through `HarnessRunStoreV1.recordNativeSnapshot`
using the database-owned `transactionWithPreCommitCheck` boundary. Session/frame freshness is checked
inside the operation, immediately before commit and after return. A signed ACK follows persistence.

Store ingestion still verifies exact canonical registration/lease/input and monotonic result history.
An authenticated late snapshot is evidence, not renewed permission to execute. The current connection
has its existing bounded lifetime; this does not implement session renewal, a production router loop,
automatic reconnect recovery or a new execution path. Timeout, lost ACK or rejected persistence closes
the session; committed history may exist without the caller receiving success. No repeat start follows.

## Evidence and corrections

Initial progress product `70136be` put freshness at the end of the store callback but omitted the
database-owned precommit boundary. Independent review identified that gap. Corrected `d42e8e9`
uses `transactionWithPreCommitCheck`; a reviewer probe injected invalidation after the application
callback and observed rejection with zero persisted events. The lifecycle regressions inject actual
disconnect/expiry at that same boundary and verify rollback with no ACK.

Root also required negotiated snapshot support and added its rejection regression. A helper parameter
initially collided with an existing local variable; that test invocation failed to load the lifecycle
module. Renaming the parameter corrected it before the frozen product. Final root focused lifecycle
checks passed8, TypeScript and scoped lint passed. Test-builder earlier focused coverage passed46;
the new negotiation regression was added afterward and is not attributed to that earlier run.
Final independent progress/store/lifecycle review found no actionable findings at `6733806` and
passed31 tests. The full CR14C run then passed550/failed1: an old lost-commit-response fixture wrapped
`transaction`, so no longer injected a failure after the store moved to the precommit API. `33bc7a4`
updates that wrapper to the actual `transactionWithPreCommitCheck`, preserving rejection, replay and
one-event assertions. Its focused bridge suite passed10; this correction changes tests, not production.

ABS builder checks passed9 focused/63 existing-plus-digest tests, types and scoped lint. Root store
integration checks passed13. Builder stage zero initially reported missing dependencies; an ignored
same-machine link to installed dependencies enabled readiness without copying/installing packages.
One package-wrapper attempt tried a registry metadata check and failed; direct installed binaries were
used afterward. Guide author stage zero reported setup required; an attempted readiness command failed
at missing tsx before executing the script. Neither negative attempt is native qualification evidence.

The lifecycle result is deliberately not an accepted completed job: owner review records one accepted
quality review, while the required verification scenario remains missing and the canonical job remains
leased. Registration/review binding and file delivery are explicitly composed by the test. Production
registration orchestration, physical artifact transport, canonical completion/revision transitions,
real supervisor/policy/signing resources, deployment and first real host task remain unfinished.

## Subsequent work

Prioritize the actual first-job path: runtime composition and registration, completion/verification and
revision transitions, owner signing and recovery. Use the guides to prepare named candidate checkouts
only once a full reviewed commit and dependency chain are issued. Do not instruct Hermes agents to
install an unimplemented service or infer live readiness from this batch.

The follow-up read-only audit found no production caller of CompletionGateStore `recordVerification`
or `recordRevision`. Native result submission creates revision zero; canonical job/attempt transitions
cannot be performed through the generic transition API. The legacy `job.event` completion path is not
plug-compatible: its artifact-lineage insert overlaps the native result manifest and it does not check
the Completion Gate. Root must integrate real verification evidence and existing result/revision stores,
then design the coordinated native lifecycle transaction rather than fabricate legacy events or bypass
the gate. Relevant sources: `src/completion-gate/v1/store.ts`, `native-result-submission.ts`,
`src/node-control/job-event-service.ts`, `src/artifacts/v1/native-results.ts` and
`src/persistence/canonical-store.ts`. The test's deliberately pending state exposed this real gap.

Lead remains Astra Medium. Settled implementation used Sol High, documentation Sol Medium, and focused
integration review Astra High. These are workload allocations, not a promise of completion tonight or
a reason to maximize consumption. Three worker slots ran alongside the root; independent review reused
available capacity. The banked usage reset was not used.
