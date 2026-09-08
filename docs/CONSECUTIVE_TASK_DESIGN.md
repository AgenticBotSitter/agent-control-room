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

### D. Combined release acceptance before service packaging

Run the six scenarios in `CONTINUOUS_PICKUP_GAP.md` through A+B+C together with
disposable canonical storage, actual signing verification and fake native transport.
Add crash-window evidence around allocation, dispatch, receipt, result delivery and
capacity release. Review both false-success and duplicate-execution risks. Only then
provide a continuous supervisor command and reviewed platform installation steps.

Independent component passes do not close D. Native host/credential/provider
qualification and sustained operation remain separately authorized live gates.

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
and storage code and fake transport. The node runtime still pins its queue before
opening; this is NOT safe consecutive execution or an installable fleet mode.
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
