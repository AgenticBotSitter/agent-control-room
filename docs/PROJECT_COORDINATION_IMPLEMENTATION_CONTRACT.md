# Project coordination implementation contract

Status: lead-owned persistence and transaction contract for issue #167.
This refines PROJECT_COORDINATION_DECISION.md; it does not claim that the
feature, live harnesses or production deployment are complete.

## Reused authority and execution

Keep WebSessionAuthority human-only. The owner assigns, replaces or revokes a
coordinator. An agent coordinator submits a strict proposal as the complete
retained result of its ordinary planning task. The server attributes that result
to the exact project, job, attempt, run, node, adapter and current binding. It
never accepts a browser-supplied agent identity or treats a node signature as the
identity of every agent on that node.

Adoption reuses canonical requests, workflows, jobs, dependencies, assignment,
results, reviews, action inbox and audit. There is no second scheduler or agent
login. A recommendation is data, not permission.

Migrations 0075 and 0076 reserve the durable records:

- current versioned coordinator binding;
- accepted or safely rejected exact proposals;
- owner-authored bounded policies;
- append-only adoption/usage receipts and canonical job mapping;
- tenant-scoped repository/logical resource identities;
- exact attempt/lease/workspace holders and immutable read/write scopes.

## Binding and proposal

A server-only resolver maps an active agent identity to executor, adapter,
optional connector profile and one binding digest. Identity ID never doubles as
executor ID. Human coordinators have no execution binding. A revoked row remains
and its next assignment increments the same head version.

The proposal format is control-room.project-coordination-proposal/v1: one strict
JSON object and no surrounding prose or code fence. Reject duplicate JSON keys
before parsing. Maximums are 32 proposed tasks, 64 dependency edges and the
existing 65,536-byte result limit. Task title/instructions reuse current bounds.
Result content cannot supply authority, credentials, endpoints, callbacks,
effects, risk or cost.

Ingestion receives only project ID and run ID through a trusted server service.
It re-inspects exact retained result evidence and compares current binding,
project, job, attempt, run, node, adapter/profile, artifact and content digests.
Invalid content is recorded with a bounded reason; raw invalid text remains only
in the protected artifact.

## Bounded owner policy

Policies bind the project, coordinator version, allowed actions, server-resolved
eligible routes, risk/effect ceiling, task count, monetary-accounting ceiling,
policy-scoped concurrency and validity. Changing a bound requires a new policy;
pause and revoke are the only in-place policy changes.

A trusted current cost-evidence port supplies admitted micro-USD and evidence
digest. Missing evidence is cost_unknown and cannot satisfy the policy. An agent
estimate is never evidence. This may leave automatic assignment disabled for an
unpriced route while owner-reviewed proposal adoption remains usable.

Policy-scoped active leases consume concurrency. Existing route/node capacity is
an independent stricter gate. Review and acceptance recommendations create
ordinary attention items only.

## Atomic adoption order

New owner/policy operations lock and recheck, in order:

1. initiating owner identity and current grants;
2. tenant, project and manual-project head;
3. coordinator head;
4. policy head, when used;
5. proposal and exact harness-run row, followed by a verified read of its
   immutable retained artifact receipt;
6. referenced existing jobs in sorted ID order;
7. deterministic destination jobs and receipt.

The policy row serializes quota accounting. Immediately before commit, recheck
the owner/grants, project lifecycle, coordinator and binding, policy
state/time/digest, route/capability, risk/effect, cost evidence, cumulative
task/cost use and active policy-linked leases. Canonical entities, dependencies,
attention records and the operation receipt commit together.

Exact replay verifies the stored request and canonical rows, returns the original
receipt and consumes nothing again even after later revocation. Changed input
under the same key conflicts. A new operation after revocation, expiry or
exhaustion fails.

## Shared work admission and lock order

Trusted product configuration resolves repository aliases to immutable
tenant-scoped resource IDs. Clients cannot create a different spelling to evade
conflicts. Each admitted attempt binds one repository/base revision, one
workspace-intent digest, up to 64 path scopes and up to 32 logical resources.
Paths follow the syntax in the parent decision and compare by stored lowercase
complete segments.

Fix existing route order before enabling parallel writers:

1. owner/session/grants or standing-policy authority;
2. tenant;
3. project/schedule/occurrence records;
4. job;
5. all immutable resource registry rows, sorted by resource ID;
6. existing held admissions/scopes;
7. node and new attempt/lease;
8. the new holder and scopes.

Scheduled assignment must acquire tenant before its current project/schedule
read. Canonical claim performs the shared conflict check so manual, scheduled
and news-collection callers cannot bypass it. Direct canonical expiry must lock
job before lease/attempt and must not retire a resource holder.

Readers conflict only with a writer of the same logical resource or overlapping
repository scope. Writers conflict with readers/writers on overlapping scopes.
Tree scope overlaps its descendants; root tree overlaps the whole repository.
Same-repository writing serializes unless an owner policy permits exact disjoint
scopes and the selected harness enforces a separate workspace. Otherwise use a
root-tree write scope.

Unknown active legacy attempts block new tenant writer admission until
reconciled; omission never means read-only. Dispatch and Codex activation bind
the admission/declaration digest and recheck it immediately before start.

Lease expiry, disconnect, browser closure, result text and transport receipt do
not retire a holder. Only exact trusted no-start evidence or exact process
retirement may change held to retired, in the completion/recovery transaction.
Quality acceptance and capacity release remain separate decisions.

## Acceptance

Implementation must prove owner-led and agent-led use of the same services,
strict proposal attribution, one-time adoption and replay, policy
revocation/expiry/exhaustion, two parallel readers, conflict serialization,
owner-permitted disjoint writers in different workspaces, preserved holders
through disconnect/restart, exact retirement, and identical manual, scheduled
and news-admission conflict enforcement. The concurrency proof uses independent
real PostgreSQL connections before the feature is declared complete.
