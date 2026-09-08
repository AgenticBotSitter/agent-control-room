# Independent cross-journey evidence audit

2026-09-08; requested checkpoint a8e67a8. Source-only inspection; no tests run by this reviewer. Existing test names below are coverage assertions in source, not newly verified pass claims. Focus: RC1/RC2/RC3 ordinary task → retained result → review → linked revision.

## Finding: linkage is implemented, but the ABS-origin branch is not joined through revision

`tests/abs-research-native-journey.test.ts:14`, **“borrowed discovery becomes the exact ordinary task executed, returned, reviewed and completed”**, joins actual borrowed collection, protected news/prepare/task routes, signed execution plan and synthetic native lifecycle through result/review/completion. It stops at accepted review and canonical success; it never requests a linked revision. Separate tests cover generic result-to-changes-requested-to-proposed-child behavior. Do not claim that one ABS-origin artifact/review/revision chain was already exercised end-to-end.

This is a narrow missing joined seam, not missing revision functionality. Reuse the existing helper and actual services, then add a research-only ABS-origin branch that requests changes rather than accepts/completes, creates the linked revision through the protected coordinator route, and replays it after reconstructing the coordinator. Compare every canonical source/run/artifact/content/review/child identifier and original instructions/provenance. Do **not** call accepted completion first and then pretend the same terminal job is an eligible changes-requested revision source: the planner intentionally requires the appropriate active canonical state.

## Exact existing coverage

| Source/test | Actual application seam and assertions | Limit |
|---|---|---|
| `abs-research-native-journey.test.ts:14` | Lines27–43 actual Control Center collection with injected DNS/fetch;44–65 private process news read/prepare and ordinary task save/replay;68–77 saved source-job→execution-plan/input digest binding;78–83 protected retained bytes and unauthenticated denial;84–94 structural verification, independent review, completion/replays and one effect claim | No revision; fake feed/network/native peer; no continuous queue worker |
| `helpers/native-quality-completion.ts:17` | Actual handoff start/poll, run registration, signed snapshot publish and result ingestion; target/profile from store;34–51 actual verification, review and canonical completion services | Quality scenario checks document structure only; completion helper does not generate semantic research evidence |
| `web-task-revision-planning.test.ts:72`, **“both restricted startup roles mount recorded owner feedback into one proposed signed revision through protected HTTP”** | Actual startup/coordinator and HTTP review→revision; exact fromRun/target/digest/content/review/feedback bindings; distinct child job; signed stored v2 plan; previous result and feedback in prompt; replay yields one plan/audit; no attempts/leases created; parent evidence unchanged | Uses generic native-quality source, not ABS source; proposal is deliberately not child execution |
| `task-revision-planning.test.ts:49`, **“restricted owner revision planning creates a signed proposed child bundle without changing the completed native result”** | Complete revision context including root IDs, review/finding/source-plan digests and revision number; canonical request/workflow/job relationship; no extra native effect | Direct coordinator call, no browser; completed native result is not synonymous with succeeded canonical job |
| `task-revision-planning.test.ts:88`, **“concurrent revision planning and a reconstructed owner preserve exactly one child bundle and audit”** | Concurrent calls and a newly constructed owner return the same child and preserve source state | Reconstruction over same backing fixture, not disk/process/database restoration |
| `task-revision-planning.test.ts:100`, **“lost acknowledgement recovers one already committed revision plan”** | Injects failure after actual transaction commit to test idempotent recovery | Does not lose a real network connection or restore a database snapshot |
| `native-task-lifecycle-integration.test.ts:80/107/128` | Actual persistence precommit disconnect/expiry fences, wrong binding refusal, lost session ACK without another start | Signed in-process channels; not a physical transport outage |
| `native-quality-completion.test.ts:74/135/145/222/252` | Verification/completion lost acknowledgement, review after deadline, expiry winning over late evidence, replaced attempt and lineage/lease boundaries | Separate cases, not all combined into ABS→revision journey |

Line numbers identify current inspected test declarations/sections and may shift with subsequent edits.

## Real interfaces versus substituted boundaries

- `helpers/native-task-lifecycle.ts:20–62` uses actual PortableNodeBridge, NativeDispatchIntakeHandler, ServerNodeSession, authentication/signatures, coordinator enqueue/stage/transmit and receipt persistence. Raw frames travel through arrays/in-process callbacks, not sockets or a mounted server. Enqueue is not a running pg-boss worker or continuous fleet claim loop.
- `helpers/native-start-authority.ts:50–65` uses in-memory SQLite journals/effect/admission stores and a synthetic profile-current check. Its native transport calls authorization but returns authored capability/start/running responses. Lifecycle helper lines64–75 supplies a synthetic completed status/text. No actual Hermes/Codex process, provider usage or host qualification is established.
- `helpers/native-task-lifecycle.ts:82–107` registers the real run/review target, emits signed progress and calls real snapshot persistence. `NativeTaskResultService.ingest` verifies the signed completed snapshot, bounded bytes and connection identity, then calls actual result capture/submission. The test directly supplies raw frame and byte arguments; no physical artifact upload/file bridge is exercised.
- `helpers/web-native-result.ts:29–35` uses **InMemoryArtifactStorage** and **InMemoryRollbackCheckpointStoreV1(testOnly)**. “Retained result” here means stored and read back through application interfaces for the fixture lifetime, not persistence across process/storage loss or independent custody.
- PGlite backs the application SQL fixtures. `helpers/task-startup.ts:18–20` documents serialized role-aware transactions and a specific TEMP metadata limitation injection. This is meaningful local SQL/role behavior, not an independent PostgreSQL primary, multi-backend concurrency or production restore proof.
- Owner keys, access tokens, enrollment/capability/telemetry and participant identity are synthetic. Review separation is exercised as application identity policy, not a real independent person/agent conducting an assessment.

## Service-level basis for the joined experiment

`src/web/v1/task-execution-planner.ts:223` (`revise`) reads the authenticated source plan and submitted result context, validates review linkage, builds a signed v2 child plan and returns an existing exact plan on replay. The child remains proposed and requires separate assignment/approval. `task-revision-operation.ts` exposes that planner operation to the restricted coordinator. The protected HTTP test already wires this actual path—use it rather than an injected revision stub.

The decisive local addition is therefore **same ABS-origin task/result/review IDs crossing this real revision seam plus replay**, not rebuilding collectors, planners or completion gates. Keep independent pg-boss candidate mapping, durable artifact restore, real provider execution and child-revision execution as separately named remaining evidence. Passing the proposed joined fixture alone would not qualify those boundaries or make the entire comparison complete.

## Focused review of the joined research fixture

2026-09-08. Source-only review of `research/reuse-comparisons/cross-journey-revision.test.ts`; root reports one successful execution (1 pass,0 fail,2050.681208ms), not independently rerun here.

The fixture preserves actual borrowed collection and protected ABS/task source creation in the same backing application fixture. It follows that planned job through retained result readback, structural verification, changes-requested review, real `TaskCoordinatorLifecycle.revisions.plan`, and reconstructed-owner replay. It avoids accepting/completing the parent first. Child prompt assertions bind the original story digest/instructions, exact retained result text and requested feedback; child receipt binds content hash/review; no child attempts/leases exist, execution-authority flags remain false, one audit remains, and synthetic effect count stays one through result reingestion. This substantially closes the identified missing **local source-to-revision join** without rebuilding existing services.

**P3 assertion gap:** before describing every run/target identity as directly asserted, add exact equality of `child.receipt.fromRunId`, `fromTargetId` and `fromTargetDigest` against the supplied actual run/target request fields. The request supplies them and the real planner validates them, but the returned child assertions currently check only sourceJobId/contentHash/reviewId. Existing generic HTTP revision evidence covers the wider tuple; the joined receipt should verify it explicitly too.

Revision is invoked through the real coordinator operation, not through protected revision HTTP in this joined fixture. Existing generic protected-HTTP tests remain complementary; this is not a role-qualification rerun. Reconstructed owner shares the same DB and storage objects, not restored disks/processes. Missing wrong-source/tampered-feedback/late-state negatives remain covered only by the separate named tests where applicable; there is no new combined lost-start/delayed-result/restore scenario here. No revised child execution, live provider, production storage or whole RC1/2/3 closure is claimed.

## Corrected joined-fixture disposition

2026-09-08, source/report/receipt recheck only. **P3 closed:** the child receipt now explicitly matches the request's run ID, target ID and target digest. The directly retained corrected TAP output records1 pass,0 failures and1979.743542ms runner duration (1588.515292ms test duration); this reviewer did not rerun it.

The new fit report accurately distinguishes real application services from PGlite and synthetic native/network/custody boundaries, direct coordinator revision from protected HTTP role evidence, and coordinator reconstruction from database restore. It explicitly leaves revision assignment/execution/second result, joined recovery, candidate queue/SDK mapping and live acceptance open. No reporting overclaim or remaining assertion finding blocks accepting the narrow joined source/result/review/revision baseline.
