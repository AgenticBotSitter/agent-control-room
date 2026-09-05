# CR14C owner-authorized task execution planning

Status: independently accepted; repository-only, unmounted. Lead: Astra Medium.

## Product behavior

An owner can turn a saved private task proposal into a separate, durable proposed execution job. The
original request/workflow/job and its inert authority remain unchanged. The child preserves title and
instructions, has exact source/template/input/profile lineage, and is readable in existing private task
views. The caller supplies only the source job and expected input digest, not replacement text or authority.

`TaskExecutionPlanner.plan` requires the existing verified human session, project/workspace read scope,
`tasks.read`, and owner-only `tasks.plan`; proposal permission alone does not grant planning. Identity,
session and grants are rechecked at commit. New plans require an active project and a current template
with at least the declared duration remaining, sampled after source locking and again immediately before
commit. Exact historical reconciliation can return the existing
receipt after project closure or template expiry; it is not fresh execution authority.

## Selected first planning class

The trusted server configuration supplies a template for one approval-required Hermes native text turn:
one typed operation `harness.hermes.native.start`, one explicit executor selector, one HTTPS destination
and credential reference, no filesystem roots, low risk, at most 300 seconds, one concurrent effect and
no unmeasurable dollar cap. The capability selector is `harness.hermes.native.runs.v1`, corresponding to
adapter `hermes-native-runs/v1`; declaring it does not register or qualify an executor. Profiles, model,
provider and actual tool restrictions still require accepted enrollment and node-local admission.
The adapter name and identifier schemas live in a pure shared contract module; the planner does not
import the native adapter subtree, transport or lifecycle code. The adapter re-exports those unchanged
identifiers, and the existing no-application-adapter-import regression remains unchanged.
Template prose does not enforce tool isolation. No native authority, profile isolation or qualification is
self-issued here. `approval_required` is retained; planning is not the approval for a provider call.

The child authority comes from that explicit template, not an expansion of the unassigned source's
authority. The source is lineage, not a parent authority ceiling. No inherited unrestricted credentials,
personal profile, tool access, MCP server or plugin is enabled by materialization.

## Atomicity and reconciliation

Migration 0045 adds one append-only authenticated plan per source job and unique child job. Deterministic
child identities plus source locking reconcile concurrent requests, new browser keys and lost responses
without creating more work. A changed source or template conflicts; history cannot be silently replaced.
Current verified profile binding, child canonical records, immutable plan and content-free audit are saved
in one owner-authorized SQL transaction. Ordinary SQL or final session/grant failure rolls back all of them.
An uncertain commit requires explicit receipt reconciliation, never automatic job resubmission.

The internal reader verifies the plan HMAC, mirrors, immutable child request/workflow/job and input/profile
bindings. Canonical state/version progress is not confused with a changed plan. This is not an externally
anchored rollback ledger; absent/corrupt plans fail closed. Database administrators and the trusted
controller process remain trusted. Private content remains private SQL data, not audit text.

After **separate** accepted claim/admission/run registration, `bindReview` carries the saved exact profile
into the existing pre-progress result submission service. It requires matching child/input/run scope and
a registration no earlier than planning. Run creation time gives exact retry a stable binding time.
It never constructs an attempt, advances a job, signs a lease or creates native-start evidence.

## Runtime and database boundary

The planner requires a trusted control-plane database composition; it is not mounted in a browser route.
The restricted private-web SQL role gains no new grants and cannot materialize these richer jobs. The
inert proposal materializer and its SQL guards are unchanged. Trusted canonical initial-record creation
is joined to the planning transaction; there are no ready transitions, attempts, leases, outbox additions,
approvals or effects. Future HTTP/coordinator mounting needs reviewed role separation and origin/session
handling, not simply replacing the web connection with a privileged database login.

The schema fingerprint/preparation inventory advances to migrations 0001–0045 / 132 tables. PostgreSQL
remains production authority, PGlite development/test-only. Existing Sites and private Node builds remain
separate. No installs, credentials, real database, services, listeners, native/provider calls or deployment.

## Verification and remaining work

Tests cover ordinary owner planning, preserved source, exact replay/concurrency, grants/logout/expiry,
template/time/profile mismatch, SQL rollback, wrong key and web-role denial. A disposable test connects
the actual planner to synthetic canonical claim/run registration, authenticated result submission and
owner review. Those **explicit fixture transitions are not implementation or acceptance of admission**;
no real task runs and required verification remains pending after owner quality acceptance.

Remaining: a reviewed executable admission/approval/dispatch composition, actual executor registration,
node ceilings and qualified enrollment, physical transport, bounded revision lineage and live private-pilot
evidence. This block does not complete C-WORK, make a template runnable or promise automatic work pickup.
