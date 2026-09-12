# RC1 Hatchet maintained-v1 transaction and outbox seam

2026-09-08; Control Room source inspection at the assigned `2fb66d7` baseline
plus current research. Upstream immutable pin
`4be0bdc7b96c33579f134d859960d4345035cd40`. **Current v1 offers a real durable
remote-trigger/idempotency alternative, but the inspected public trigger does not
participate in a caller-owned PostgreSQL transaction.** This replaces the earlier
legacy-admin-only uncertainty for these specific entrypoints, not a rejection of
Hatchet generally or a final queue selection. Root retains architecture/authority.

## Actual maintained path, not README or v0

`sdks/typescript/src/v1/client/client.ts:439–445` exposes runNoWait and delegates
to the current v1 AdminClient. `v1/client/admin.ts:210–294` accepts workflow/input
and parent/child/metadata/worker-label/priority options, serializes input, and calls
workflowsGrpc.triggerWorkflow. It returns WorkflowRunRef from the returned run ID.
No caller database/session/SQL callback is accepted by this method. Current
`v1/index.ts` and `v1/client/client.interface.ts` expose admin, events, workflow,
schedule and related clients; neither inspected interface adds a caller-transaction
entrypoint. This is bounded interface inspection, not a claim every source line or
possible extension across the whole repository was searched.

The actual v1 admin wraps the call in `retrier` and refuses retry for ALREADY_EXISTS,
turning collision metadata into IdempotencyCollisionError. `util/retrier.ts`
defaults to eight attempts; its maxAttempts option is clamped to at least one.
Thus an unchanged default trigger is not a no-retry client after uncertain delivery.
Use the existing configuration to bound attempts in any later experiment rather
than replacing retry logic or treating all retries as approved physical execution.

Server-side distinctions are concrete:

- `internal/services/admin/server_v1.go:364–407` and newer
  `internal/services/admin/v1/server.go:806–843` route idempotency-bearing trigger
  batches through TriggerFromWorkflowNames; other paths can submit task-processing
  messages. The latter also has an optimistic scheduling path. These are engine
  ingestion choices, not caller transaction enlistment.
- `pkg/repository/trigger.go:474–499` prepares an engine OptimisticTx, defers
  rollback, prepares tasks/DAGs/payloads and commits it. The lower-level
  sharedRepository method at456 takes that internal transaction. This private Go
  implementation parameter is not a supported TypeScript caller-owned SQL seam.
- The public REST v1 workflow-run handler creates a trigger request and invokes a
  proxy (api/v1/server/handlers/v1/workflow-runs/trigger.go:62–73). Its returnOnlyId
  option bypasses waiting for OLAP replication (92–108); normal return may poll
  replication (121–141). It does not merge a CR SQL transaction with the trigger.
  The server comment explicitly recognizes trigger success can precede detail
  availability; do not interpret a detail-read failure as proof no run was created.

No file named outbox appeared in the complete, non-truncated source tree response.
Filename absence alone does not establish absence of an implementation. The
conclusion above rests on the actual public signatures and transaction path,
not that filename search.

## Strongest supported alternative and its evidence

Hatchet supports workflow-configured CEL idempotency from input/metadata. Actual
`v1/task.ts:69–108` defines TTL strategy and status strategy with fallback TTL;
the latter releases on terminal state, bounded by fallback time. Neither is an
unlimited canonical replay ledger. The actual example declares `input.id` with
60-second and two-second windows and a status-based ten-second fallback.

Read actual `v1/examples/idempotency/idempotency.e2e.ts`, not just mock tests:

- Direct duplicate trigger expects IdempotencyCollisionError and the original
  run external ID, with exactly one listed run (41–71).
- Bulk duplicate expects one successful ID and one collision (73–95).
- Expiry deliberately permits later reruns and expects three runs (97–132).
- Repeated event publication expects one triggered run (134–184).

These tests require a real client/worker through the upstream test harness; they
were **read, not run**. The current admin unit tests use mocked gRPC channels and
are not service evidence. No new E2 pass count, availability metric or performance
claim is assigned.

The strongest CR adaptation is therefore an existing canonical transactional
outbox followed by bounded public remote submission/idempotency and explicit
receipt reconciliation. CR already has `control_outbox` inserts in
`canonical-store.ts`, plus `DeliveryStore.claimOutbox`, markOutboxDelivered,
markOutboxFailed and recovery in `src/persistence/delivery-store.ts`. Claiming is
tenant-scoped, transactional and uses SKIP LOCKED plus a claim token. **Do not
invent another generic outbox.** These primitives are not already a Hatchet
delivery adapter or proof that native task submission can switch to them unchanged.
Mapping exact canonical intent/digest, receipt, expiry and unknown remote outcomes
remains real integration work; expired backend dedup cannot authorize a new
physical run. This report does not design a new authorization protocol.

The existing `v1/embedded.ts` is also a substantive setup alternative: managed
engine sidecar, optional explicit binary/checksum/version and existing databaseUrl,
configurable data root/ports. It defaults to downloading an engine and bundled
PostgreSQL, so none of it was invoked. Its existence prevents a blanket claim that
Hatchet necessarily requires a separately operated cloud or full external stack.
It does not introduce caller transaction enlistment merely by sharing a database
URL. Embedded source was inspected only through its setup option definitions;
its complete downloader/runtime effects are not qualified here.

## Comparison with the exact current responsibility

| Route | Transaction boundary | Remaining adaptation |
| --- | --- | --- |
| Current pg-boss12.30.0 | Actual `preparePgBossBoundedSubmission.enqueueInSession` supplies the same DatabaseSession through executeSql to boss.send | Existing profile requires deterministic fresh ID, retryLimit0 and queue configuration lock; no orphan adoption. Preserve canonical replay before enqueue. |
| DBOS4.27.6 | Prior inspected actual enqueueInTransaction accepts caller ClientBase | Structural SQL-client bridge is plausible; prior migration failures are setup evidence, not disproval. Real PG comparison remains separately pending/current root work. |
| Hatchet inspected v1 trigger | Remote API → engine-owned transaction/message path | Not a direct same-session replacement. Existing CR outbox plus supported remote idempotency is a different, still viable responsibility allocation. |

`pg-boss-bounded-submission.ts:46–51,97–117` binds the supplied session and requires
the returned fresh ID exactly; authenticated canonical replay is deliberately
handled before this adapter. `pg-boss-native-task-submission.ts` binds the native
profile, calls operational queue ID noncanonical, and rejects retries/dead-letter
configuration. Hatchet collision run IDs alone cannot replace these authority
checks. Nor does raw access to Hatchet's internal Go repository justify writing
its private tables directly from Control Room.

## Selection consequence and smallest decisive experiment

For **unchanged caller-owned atomic SQL enqueue**, these inspected Hatchet v1
entrypoints are excluded on concrete interface grounds. A daemon performance
test cannot make that missing public parameter appear. No full-service install
is needed merely to establish this narrow mismatch.

For **durable post-commit handoff/scheduling**, a real Hatchet comparison can still
change a broader selection. If root selects that responsibility for competition,
exercise an actual committed CR outbox item through the maintained public client:
one successful submission, dropped acknowledgement, restart, same-ID changed
payload, duplicate inside and after the backend dedup window, and exact receipt
reconciliation without duplicate physical start. Reuse existing outbox machinery;
retain no native agents/providers in the fixture. Do not call a mocked gRPC test
or direct internal SQL insert that experiment. Its added relay/reconciliation
cost must be compared against the working pg-boss path and DBOS same-session route,
not omitted because Hatchet has more orchestration features.

Production deletion: zero; no new application queue/outbox/protocol. No measured
implementation savings, throughput or resident memory. Root MIT source evidence
from the prior dossier does not clear the full SDK/engine/native closure; exact
release/package matching and transitive notices remain shipping work.

## Acquisition limits

Only public exact-pin source/tree reads, in memory, with 15-second deadlines and
bounded response sizes; no clone, source archive, install, daemon, credential or
GitHub write. `f1-hatchet-source-receipt.json` retains each URL/status/bytes/SHA256,
including repeated narrowing reads; no fetched source was executed or retained
as product code. The tree response was non-truncated. There is no temporary
download root to clean and no new service handle. Some bounded reads checked size
after arrayBuffer rather than streaming, so they are not hard transport-memory
containment. No claim of exhaustive candidate census or every repository test.
