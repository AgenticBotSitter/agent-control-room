# Consecutive-task integration design

2026-09-08. Architect-authored local implementation direction. This supplements
`CONTINUOUS_PICKUP_GAP.md`, CR14A and the unchanged CR5C authority contract. It does
not enable a daemon, provision a node or qualify production execution.

## Product outcome and chosen approach

An enrolled, unpaused node should finish one independently approved task, deliver
its result, and become eligible for another approved task without owner message
relay. Owner quality review can remain pending while a different independent task
runs, but dependent work must retain its existing dependency/review gates.

Keep pg-boss as the work dispatcher and PostgreSQL as the only global allocation
authority. Keep the existing signed native dispatch, receipt and snapshot formats,
local effect claims and per-task runtime. Do not add a new broker, replicated global
queue, remote shell command channel or generic agent RPC interface.

What is custom here is application lifecycle glue: connecting the existing canonical
queue selection to a task-bound server session and matching node runtime. None of
the borrowed queue/transport components knows Control Room's combined approval,
lease, enrollment, effect and review bindings. This is the specific reason that
glue cannot simply be delegated to pg-boss retry settings or a service restart.

## Boundaries that the implementation must preserve

1. Authenticate the individual node and current enrollment before exposing a task
   locator. Machine reachability and an HTTP request are not task authority.
2. Select only from existing canonical queue intentions for that node, scope and
   current assignment. Reuse `NativeQueueAuthority` and coordinator revalidation;
   discovery SQL, sort order and a returned locator are not claims or permission.
3. Claim/allocation and recovery must serialize under existing canonical transaction
   ownership. An in-memory mutex is insufficient across server restart. Determine
   whether existing node/lease reservations provide the necessary durable invariant
   before proposing a migration. Never claim it from a single-process fixture.
4. Preserve one active admitted task per selected native adapter in the first
   implementation. A second connection cannot free capacity or replace unresolved
   ownership. Capacity identity is the stable enrolled node/adapter, never a task,
   project, queue or connection ID. The existing node-wide lease limit may remain
   more restrictive; do not partition it by adapter without an explicit decision.
   No batching of native effects behind one task approval.
5. Freeze the exact task/attempt/input/packet/queue/enrollment binding for the active
   session. Revalidate at staging, transmission and local effect admission, using
   the existing stores. Dynamic selection must not turn these into mutable globals.
6. Reuse the existing signed dispatch and local admission checks to establish the
   next runtime's binding. An unsigned assignment hint may locate evidence but may
   not seed accepted dispatch, forge a lease or bypass reconciliation.
7. Before any fresh pickup after restart, reconcile retained canonical and local
   evidence for outstanding work. Unknown or contradictory ownership stops pickup.
   Never erase journal rows or rotate task IDs to clear an ambiguous run.
8. Close/drain old task resources before a new runtime uses that adapter's capacity.
   Separate clean resource release from task success, result receipt and quality
   approval. Cleanup timeout is uncertainty, not a free slot.
9. Drain/update stops new admissions. Existing tasks retain only their already
   valid authority; no lease extension or fresh signature follows from updating.
   Reopening fresh admission is a separately verified lifecycle transition.
10. Empty eligible queues wait with explicit bounds/backoff and no provider call.
    Transient network uncertainty may reconnect only through exact existing-work
    reconciliation, never by blindly submitting another native start.

## Reuse map and implementation order

### A. Durable selection and allocation

Inspect existing node reservations and native queue transactions. Define the exact
durable predicate for an idle node and the atomic transition to its selected task.
Use `TaskAssignmentCoordinator.locateApprovedQueueDelivery` for canonical approval
revalidation and the existing queue intent as the task locator. Its current
`recoverForReadyNode` recovers only demonstrably never-staged work; it must not be
repurposed to retry possibly transmitted work or treated as a general selector.
Reservation or lease expiry is not proof of native stop. After possible dispatch,
retain a durable busy/uncertain interpretation until exact-run reconciliation and
clean release; existing ready-frontier expiry cannot satisfy that predicate alone.

Exit evidence: concurrent selection cannot allocate two active tasks to the same
capacity; revoked/expired/unassigned candidates do not become assignments; restart
reconstructs the same allocation. PostgreSQL concurrency evidence remains distinct
from sequential PGlite component evidence.

### B. Server connection ownership

Replace only the *configuration-time* fixed peer/task association for an explicit
consecutive-task mode. Retain fixed-task mode unchanged. The authenticated node
identity selects its canonical allocation, never a browser/body-supplied task ID.
Each allocated task still gets an exact managed input/attempt binding. Preserve
generation fencing, replay guards, delivery uncertainty and receipt registration.

Exit evidence: two independently approved tasks route to their own attempts/results;
old connection IDs and late packets cannot act on the next task; reconnect resumes
only the existing allocation. Do not ship an arbitrary operator `nextTask` callback
as if it supplied canonical selection or durable ownership.

### C. Node runtime lifecycle

Factor node-level connection/journal ownership from the existing per-task runtime
without weakening its queue-ID guard. Resolve the task binding from verified existing
dispatch and durable admission evidence, then construct one runtime. Reuse the
current policy/profile/recovery readers and bounded connector operations.

Exit evidence: same-task replay cannot start twice; a task switch cannot inherit
approval, result buffers, recovery scope or capacity from its predecessor; unresolved
native work or cleanup refuses a switch. Capture real retained journal state, not
only a mocked `completed` callback.

#### Verified lease delivery is a prerequisite, not a policy callback

Source audit after the unassigned-runtime implementation found a concrete integration
gap. `createNativeCurrentPolicy` already composes the right protected sources, but
its `createNativeLeaseEvidence` reader requires BOTH a saved signed `job.lease.grant`
and a current matching bridge attempt. These are absent from the native delivery
journey: `ServerNodeSession` signs connection/reconciliation/ack/native-dispatch
frames, not lease grants; the native runtime rejects lease grants; the generic
`PortableNodeBridge` command branch records a grant but does not update an attempt.
Thus simply permitting another frame type would still not establish usable policy.
The lease-evidence fixture explicitly consumes a grant, records its command and
upserts an attempt. That privileged fixture setup is not an implemented host path.

Keep the existing `job.lease.grant` protocol and `createNativeCurrentPolicy` reader.
Do not create a second lease format, treat the approval packet as a lease, or replace
the verified reader with the manually supplied policy used by journey fixtures.
The remaining implementation needs all of the following, as one joined block:

1. Derive the exact grant from the coordinator's checked canonical lease/authority,
   not from node-provided task metadata. Retain signed grant and dispatch identity
   under the existing durable staging/transaction owner before transmission.
2. Send the grant and dispatch on the same captured authenticated generation with
   defined ordering. Partial delivery must remain recoverable as the same task;
   it must not trigger another start, silently switch tasks or consume another claim.
3. Accept the exact grant into existing inbox/command/attempt storage atomically,
   with replay identity and terminal/superseded-attempt protection. Command receipt
   alone is not admission. Do not use unrestricted `upsertAttempt` on wire input.
4. Construct the existing policy reader from that retained grant, approved request,
   trusted executor/node configuration and checked parent authority chain. Revalidate
   the same evidence and pause/capacity state at the existing pre-effect boundary.
5. Prove the full journey with the real policy reader, without fixture-inserted lease
   receipts or a synthetic `readCurrent` bypass. Missing grant, dispatch-only,
   grant-only, wrong generation, conflicting epoch, cancelled attempt, interrupted
   delivery and reconnect must not release native execution without complete proof.

No production launcher or receive allowlist was broadened by this audit. The existing
two-task tests remain valuable result/capacity evidence, but not evidence that this
lease-to-policy path is implemented. This prerequisite precedes fleet installation.

The first persistence part is now implemented as `SqliteBridgeJournal.recordInitialLease`.
After an authenticated frame has entered the existing replay inbox, this trusted
intake primitive commits its exact command and initial attempt together. It checks
the retained inbox mirrors/digests, preserves running progress on exact replay and
refuses partial/conflicting/terminal prior state. Synchronous freshness fences run
before and after writes; a late failure rolls both writes back while retaining the
inbox. Stored replay summaries use the existing reconciliation schema, including
bounded checkpoint IDs and safe numeric fields. No table or wire format was added.

The lease-evidence fixture now uses this atomic primitive instead of separate command
and unrestricted attempt writes. Its replay consumption and freshness fence remain
privileged synthetic setup. Tests cover visibility from a second SQLite connection,
reopened storage, failed fences and corrupted prior records. This does NOT implement
the server grant producer, channel/task-bound intake handler, lease renewal or the
runtime allowlist/policy wiring. Signature verification and live authority freshness
remain mandatory at that handler and the existing verified policy reader.

`createNativeLeaseIntake` now supplies a bounded, exact-task/channel check around
that storage primitive: strict grant parsing, pinned signature plus current trusted
key/revision, request/lease/authority equality, real cancellation signal, monotonic
five-second and lease/envelope deadlines, and a synchronous task-owner freshness
fence. It clones caller input before awaiting trust; failures and overlap close the
intake, and a late key resolution cannot revive it. The grant must already be in
the authenticated replay inbox. This is not an alternate authenticator or a source
of native execution permission. Exact stored grants remain subject to the existing
verified policy reader and its parent-authority/ceiling/profile/capacity checks.

This intake is not yet attached to the native bridge/session. The server's durable
grant producer and delivery ordering, capture of the verified dispatch/channel
fence, grant-aware readiness and actual policy-reader composition remain required.
Do not enable a service or start on dispatch-only readiness using this component.

`createNativeLeaseCommandHandler` now adapts that intake to the existing
`PortableNodeBridge` command-handler interface. It captures the supplied exact task,
binds one negotiated connection and composes the channel guard with the task owner's
freshness fence. The joined bridge test authenticates a synthetic signed grant,
consumes replay evidence, invokes this handler, persists the command/attempt and
reads the result with `createNativeLeaseEvidence`. No test-side command/attempt
insertion is used in this journey. Task invalidation during trust resolution leaves
only an unprocessed authenticated inbox entry and no usable lease state.

This closes the generic bridge-to-lease-reader integration gap, not the remaining
native session gap. Its grant signer is still a synthetic fixture, and the exact
task/freshness fence is supplied explicitly. Canonical server grant staging,
native runtime handler installation and grant-aware start readiness remain open.

The canonical coordinator now calls `prepareNativeTaskApprovalWithLease` inside its
existing checked transaction. This reuses the original approval builder over one
captured input and derives an unsigned existing-format grant from the same job and
lease. Node/job/attempt/lease/epoch, canonical acquired/expiry times and complete
authority are unchanged. Its deterministic offer ID is correlation for native
direct delivery, not evidence of a separate offer negotiation. No browser operation,
signature or transmission is added. Signed grant retention and same-generation
delivery still need to be joined to the existing envelope/transmission intent.

### D. Combined release acceptance before service packaging

Local progress on C/D: the per-task runtime now provides exact-binding drainage
evidence, and `createNativeTaskSettlement` joins separately accepted cleanup proof to
execution-first/effect-last durable settlement. The integrated retained-result test
uses the real runtime and stores with synthetic producer qualification. Historical
committed settlement recognition now reuses those protected journals, but this does
not itself provide automatic task turnover or physical restart acceptance. The
manually composed two-independent-task proof below now joins these components.
See `NATIVE_CLEANUP_EVIDENCE_DESIGN.md`; do not enable continuous service packaging
from this partial acceptance.

Run the six scenarios in `CONTINUOUS_PICKUP_GAP.md` through A+B+C together with
disposable canonical storage, actual signing verification and fake native transport.
Add crash-window evidence around allocation, dispatch, receipt, result delivery and
capacity release. Review both false-success and duplicate-execution risks. Only then
provide a continuous supervisor command and reviewed platform installation steps.

Independent component passes do not close D. Native host/credential/provider
qualification and sustained operation remain separately authorized live gates.

### Joined two-independent-task evidence

`tests/native-consecutive-tasks.test.ts` now runs independently approved A and B
through one canonical database, managed server, bridge journal and local native/
admission/execution/effect stores. Canonical queue delivery uses unbound initial
server generations and existing signed dispatch. The existing quality coordinator
releases each completed task's canonical lease while review remains pending; the
separate cleanup settlement closes its runtime and frees its local effect hold.

The canonical route remains two (one unrelated seeded lease plus one task), and
the native ceiling remains one. B assignment is refused before A's canonical release.
B's pre-effect policy check is refused before A's local settlement, with no B native
run or effect record consumed. After release, B starts once and its duplicate start
adds no native call. A's obsolete generation and closed runtime cannot act on B.
Distinct A/B result bytes, hashes and attempts remain intact in the artifact store;
both quality reviews remain pending, and the unrelated seeded lease is preserved.

This is injected local integration evidence, not automatic continuous operation. The
test explicitly supplies B's exact policy, invokes delivery/pumps,
reconciliation and synthetic qualified cleanup. Both runtimes now discover their
queue from accepted signed dispatch, without configuration-time queue IDs. Automatic
lifecycle sequencing,
lifecycle ownership across tasks, real cleanup qualification, physical restart and
PostgreSQL concurrency/sustained-operation acceptance remain open. Do not install a
continuous service based on this test alone.

## Explicitly unresolved before A implementation

- Identify the existing durable node-capacity reservation and its transaction locks,
  retention, terminal/release semantics and restricted-role access.
- Specify task discovery/assignment transport using existing signed material; do not
  invent a new unauthenticated bootstrap to work around the runtime's queue binding.
- Define the exact evidence permitting capacity release without requiring owner
  quality review of an independent completed task and without discarding uncertainty.

These are implementation decisions to resolve from source and tests, not missing
owner passwords. The owner need not be awake for that local work. Any production
migration, service start or real agent call still requires its separate authority.

## First allocation-source finding

`ResourceReservationStore` and migration `0014_cr6c_resource_reservations.sql`
provide durable resource-key heads and `FOR UPDATE` capacity serialization. They
also automatically expire holds and exclude expired holds from used capacity.
`CanonicalControlStore` uses the same tables for ready-frontier promotion, whose
authority is explicitly no-effect repository-work preparation. The current native
planner/coordinator does not call the reservation store. The active-lease unique
index is per job, not per node.

Therefore these tables are useful existing allocation infrastructure, but their
TTL-based capacity release is not proof that a possibly running native task has
stopped. Reuse cannot mean wiring native pickup directly to `reconcile()` or using
an expired lease as an empty-slot signal. A native occupancy/reconciliation binding
must remain durable through expiry and be checked under the same allocation lock.
Determine whether an existing native run/effect/attempt record provides that binding
before adding a new table. Do not silently alter ready-frontier expiry semantics.

### Existing native allocation and release are the primary reuse candidates

The deeper callsite audit found `TaskAssignmentCoordinator.assign` already locks
tenant, project and node, counts all `state='active'` leases for that node, compares
with the reviewed route's `maxConcurrentTasks`, and creates the canonical attempt/
lease in the same transaction. It does not filter away elapsed active leases.
Preserve this node-wide allocation fence rather than adding a competing allocator.

`NativeTaskCompletionService.releaseCapacity` already requires exact retained
completed snapshot, result hash, run/job/attempt/lease/epoch binding and completion
within its authority deadlines. It records an authenticated release receipt with
`qualityAccepted:false`. `TaskQualityCoordinator` invokes this path while quality
review is pending. This is the existing way to free canonical capacity for unrelated
work without pretending the owner accepted quality; do not invent a parallel release.

The separate explicit assignment-expiry operation records `confirmsNativeStop:false`.
The consecutive-task admission path must distinguish that expiration from a verified
completion release, check retained unresolved run/effect evidence, and require node
runtime cleanup before a new local admission. A server release receipt alone does
not attest to native adapter cleanup. These remaining predicates, dynamic selection
and server/node handoff are still unfinished; no new capacity table is justified by
the source audit so far.

## Canonical routing and fixed-session queue integration

The canonical queue lookup now returns a frozen node and exact project/job/attempt/
execution-input binding after existing approval/queue-intent revalidation. It does
not disclose task prompts, credentials or signing material and is not new authority.
Managed delivery checks that projection against the queue reference before staging.

An actual HTTP-path regression exposed a prerequisite defect: queue delivery called
the raw session stage/transmit methods without advancing the managed input's FIFO
state, so its later signed receipt was rejected. Queue delivery now enters that
same input FIFO, checks initial/ready state and the exact fixed task, retains the
captured session generation, and enters sent state only after successful canonical
stage/transmit. The signed receipt then uses existing registration and result paths.
No callback is exposed on the wire facade. Readiness recovery remains enqueue-only;
it must not await delivery from inside the same FIFO.

This makes one already-approved queued task usable through the existing HTTP
session, not consecutive pickup. A+B+C and combined release acceptance D above are
still open.

### Explicit server-side queue binding (local integration only)

An optional peer `assignment: "queue"` now omits configuration-time task identity.
It accepts initial connections only and cannot be combined with a fixed task. The
authenticated generation remains unbound until `deliverApproved` supplies its first
canonically revalidated task; the existing FIFO freezes that exact binding and
routes the signed receipt and result to it. It never switches task in place. Manual
owner stage/transmit calls cannot select the task in this mode. No task/queue field
is added to the HTTP client request. Fixed-task/recovery configuration is unchanged.

The actual connector journey exercises this server mode with real local protocol
and storage code and fake transport. The fixed node runtime pins its queue before
opening; the separate initial-only unassigned factory described below does not.
Neither is an installable continuous fleet mode.
A new initial connection currently creates another unbound server generation, so
the durable outstanding-task predicate and native cleanup/recovery remain mandatory
before operational enablement. A connection close does not establish native stop.
No supervisor or operator example enables this mode.

Further source audit found another actual turnover gap: native start records an
active local effect claim, while the native adapter/recovery/reporting paths do not
settle it. Existing `SqliteEffectClaimStore.countActive` correctly retains claimed,
executing and ambiguous claims independent of elapsed deadlines. Do not delete or
discount those claims to admit the next task. Define exact retained native/result/
cleanup evidence for the existing effect-state transition before any automatic
local turnover. Reported native completion alone does not prove OS descendants
have exited; that existing adapter caveat remains unchanged.

The independent profile audit confirms the current supervised profile snapshot has
no task-specific stopped/descendant-absence evidence. `CR14C_NATIVE_PROFILE_EVIDENCE_CONTRACT.md`
and `CR14C_CONNECTOR_LIFECYCLE_CONTRACT.md` leave physical cleanup integration open.
The reusable effect/execution stores can record confirmation, but only validate
event shape/history; hashing a completed snapshot cannot manufacture a verified
destination/cleanup receipt. The next local implementation must define and verify
exact task-bound cleanup evidence, with a host producer still requiring separately
authorized qualification. Codex's descendant-aware cancellation evidence is scoped
to its own executor and cannot simply be relabeled Hermes evidence.

The local read-only consumer is now specified in `NATIVE_CLEANUP_EVIDENCE_DESIGN.md`
and implemented as `createNativeCleanupEvidence`. It requires a separate scoped
owner acceptance for the cleanup producer and exact supervised run/marker evidence.
It deliberately does not settle the effect, create a producer, or enable the next
task. Physical host qualification and lifecycle settlement remain unfinished.

### Initial node-side queue discovery

`createUnassignedNativeNodeRuntime` accepts explicit `assignment: "queue"`, without
a queue ID. It reuses the existing runtime and binds once, only after signed dispatch
intake records the exact frame and accepted receipt in the existing bridge journal.
Queue identity is checked again inside the receive FIFO, and reporting is created
only after binding. Before assignment, `hasAcceptedDispatch()` returns false and the
queue ID getter refuses access. Closure before assignment performs no native work.
The existing fixed-task configuration validator and production launcher are unchanged.

The same-store two-task test now uses this factory for both tasks. Separate negative
checks cover forged owner approval despite a valid synthetic server signature and
competing dispatch intake. This removes the preconfigured queue-ID dependency, not
the need for exact task policy: the host still supplies task-specific policy and must
reconcile outstanding work before choosing an initial session. Automatic lifecycle
ownership, real cleanup production/qualification and fleet startup remain unfinished.
