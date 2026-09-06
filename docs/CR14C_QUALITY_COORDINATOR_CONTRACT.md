# Scoped quality coordinator mounting

2026-09-05. Root-owned contract; repository-only implementation.

Mount the accepted automatic-verification and native-completion services into the existing bounded
task coordinator and verified two-pool application startup. Expose one optional INTERNAL operation:
`quality.reconcile({tenantId,projectId,jobId,runId,targetDigest,contentHash}, AbortSignal)`.
It is not a browser route, arbitrary SQL callback, worker execution command or a new signing path.
No timers, discovery scans or background retries are introduced.

Every constituent transaction validates exact tenant/workspace/project/job/run scope against current
canonical SQL, with the project locked against reassignment. The original HMAC plan, result bytes,
profile and target remain verified by the accepted services. Captured configuration pins rules and
keys to the same review/harness evidence used by the planner and private result views. Absence of
quality configuration exposes no quality operation. Rule configuration is never accepted from HTTP.

Reconciliation first reads current target status and exact bytes. If suitable automatic checks are
configured, record them through existing immutable/checkpointed verification. Return truthful waiting
or changes-requested status until all required verification and independent reviews satisfy the gate.
Only then call the existing atomic completion operation. A later reconcile replays committed records,
never dispatches another run. Verification may commit before completion fails; propagate uncertainty,
do not roll back or pretend to undo prior transactions. The caller reconciles the exact input explicitly.

Each operation uses the existing bounded admission/drain lifecycle. Snapshot input before asynchronous
admission, check cancellation before every constituent transaction and at precommit, and preserve
pool/clock currentness. A scope mismatch, unavailable pool, invalid checkpoint, unsupported config,
corrupt record or unknown status is not an empty queue or successful job. Graceful close admits no
new calls; timeout closes once and leaves incomplete saves uncertain.

Migration0054 adds inert native-run locking support and a coordinator-only gate-record guard. Offline
role setup and exact preflight admit only required native run/event/plan/artifact reads, immutable record
locking, service-verification INSERT and existing gate integrity CAS fields. No native run/event/result
writes, profiles/targets/reviews/findings/revisions/approval records or external-effect writes are granted.
The private web role remains unchanged. Both ordinary and new capabilities must pass under the exact
non-superuser coordinator role; extra/missing grants and disabled guards fail the schema/role gate.

The verified application exposes only the captured scoped quality operation to trusted server
composition, never database handles or keys. Startup performs both fixed-role preflights first and
retains existing fail/close behavior. No service is installed or started on a real host in this block.
Actual result/review event routing, revisions and upstream workflow completion remain distinct work;
this block does not silently implement them through unrelated generic mutations.

Root owns normative schemas, security, SQL, service composition and final decisions. Isolated internal
test lanes cover actual limited-role reconciliation and startup/drain behavior; a separate reviewer
checks the frozen combined implementation. Existing installed dependencies only. No installation,
download, provider/native credentials, production SQL, DNS, listener or deployment authority is implied.
