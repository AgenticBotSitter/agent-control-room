# CR14C private task workspace

Status: independently accepted repository implementation; acceptance and independent review are recorded separately.
Lead: Astra Xhigh. This continues C-WORK's useful website integration, not live activation.

## Owner workflow

Every ordinary or owner-authorized Idea project has a Tasks page and separate task-detail URLs. The page
lists existing canonical jobs, saves a concrete requested result and shows recorded attempts/agent progress.
Titles/instructions are private project content, rendered as text, never executable markup or commands.
The source of truth is PostgreSQL; browser state is temporary presentation, not a second queue.

The shared Access assertion, current human membership, session revocation and project grants apply to pages
and every API request. `tasks.read` is additional to the project's ordinary read or owner-only Idea read;
`tasks.propose` is additional for proposal creation. A project-scoped grant never grants catalog-wide access.
Idea project reads retain their existing integrity verification. Tenant/workspace, actor, effect scope and
model/provider selection cannot come from a task request body. There is no new authentication mechanism.

The project list links to a stable project/task page that can open in its own browser tab. Bounded read-only
refresh runs every 30 seconds while visible and on focus. It never submits work, resumes a run, cancels a
task or retries a save. Missing service/access clears the displayed task records; no fixtures replace them.

## Save a proposal, do not implicitly assign work

The only new command accepts a title (120 characters) and instructions (4,000 characters), at most 24 KiB
of JSON. It rejects unknown fields/control characters and existing known secret patterns. Pattern rejection
is not a complete data-loss-prevention system; the UI tells the owner not to include credentials.

Inside one existing session/grant transaction, the server validates the project and current proposal grant,
creates the existing canonical draft request/proposed workflow/proposed job bundle, appends audit evidence
and stores an append-only receipt. All stores join that transaction without a nested commit. Identity/grant
freshness is rechecked before the outer commit. Any ordinary failure rolls back the whole bundle and receipt.

These are **unassigned proposals**: no filesystem, network, credentials or effects; no assigned executor;
no attempts, leases, dispatch/outbox records or approvals. The five-minute inert authority ceiling is not a
promise that work will start within that time. Later reviewed planning/admission must materialize a properly
bounded executable job with lineage and actual supported capability. It may not mutate or silently expand
this proposal's immutable authority. A title or human instruction alone is not execution authorization.

Idempotency is exact per tenant/identity/key and binds workspace/project/action/body. A replay returns the
original immutable creation receipt, not a claim about current execution state. It rechecks current read and
proposal permission but can reconcile an already-saved proposal after project closure. New proposals require
an active project. Changed key reuse fails; concurrent identical submissions create one canonical bundle.

An uncertain response never causes automatic retry. The browser retains the exact pending body/key in this
page's memory, holds changed submissions and offers **Check this exact save again**. The owner can explicitly
reconcile the same receipt, or inspect saved tasks. Reload/closing loses that temporary pending key; it does
not undo a committed proposal. The owner must inspect saved work before submitting another after that event.
Read refresh and transport reconnect remain read-only. This is not native/provider resubmission.
An unsuccessful check after uncertainty, including a session/permission denial, does not settle the original
save. Its exact body/key and changed-submission hold remain until a positive matching receipt is received
in that page instance. Only a definitive first-attempt rejection may release the hold without a receipt.

## Truthful progress and result boundaries

The detail view reads canonical request/job/attempt lineage separately from integrity-verified harness
observations. A single harness query verifies its full stored run/history together before projection. Native
snapshots expose only fixed state/timestamps, latest nullable token counts and producer result hash/size.
No native session/run handle, node/connection configuration, credentials, raw diagnostics, tool data or final
result text is returned. Missing harness integrity material is `not_configured`, never an empty live roster.
Incorrect integrity material or corrupted evidence makes the read unavailable, not an unverified success.

The job state and agent-reported state are labeled separately. A native completed observation does not
complete the canonical job, independently verify a result or record owner acceptance. Unknown tokens/start
time/cost remain unknown; zero tokens remain zero. Cancellation is reported adapter evidence, not independent
proof of OS or external-effect cessation. No dollar limit is claimed enforceable. Observations older than
120 seconds or postdating the view clock are labeled as not a current live signal; that label is presentation,
not lease renewal, host qualification or authority to act.
Native offline, expired or unknown availability, and disconnected harness state, are prominently unavailable
even when the observation timestamp is fresh. The retained state is explicitly a last report, not a current
working claim. Times are labeled observations, not measured server receipt times.

The task catalog uses stable ID pagination, 50 per page. Detail shows the latest 10 attempts, latest 10 run
records per attempt and latest 50 native observations per run; omission indicators are explicit and retained
history is not deleted. Browser responses are bounded to 1 MiB. This view is not a complete history export.
Live dispatch, verified artifact-content transfer and owner review/revision commands remain visibly
`not_connected`. There are no pretend action buttons or fabricated outcomes for these remaining integrations.

## Database/profile compatibility

Migration 0041 adds append-only task receipts, a project catalog index and invoker-only insert guards.
The fresh private web role receives canonical request/workflow/job INSERT plus task/attempt/harness SELECT;
it receives no canonical UPDATE, attempts/leases/outbox/effects/approvals/harness evidence write privileges.
For a non-superuser web-role member, SQL insertion itself requires initial state/version and an unassigned,
effect-free job envelope. The ordinary trusted canonical service retains its existing wider coordinator role.
No SECURITY DEFINER, automatic role change, startup migration or live provisioning is added.

These SQL permissions are not per-row/tenant isolation from a compromised application. The existing trusted
web service enforces tenant/project membership. Administrators/migrators remain trusted and can change SQL.
The startup fingerprint and exact effective-role inventory advance to migrations 0001–0041 / 128 tables.
The disposable preparation/rehearsal packet must be regenerated for this schema; previous pins fail closed.
Production migration, backup/rollback/rolling compatibility and actual PG17 constraints still need a separately
approved rehearsal. Updating repository SQL does not migrate a real database.

## Acceptance scope

Installed-dependency tests cover canonical atomic save/rollback/receipt recovery, grants/revocation/Idea scope,
restricted-role execution denial, signed native snapshot through the private view, unknown/stale/result
semantics, bounded pagination/history and escaped accessible panels. Compiled private route tests cover the
actual built handler and disposable SQL. Preserve the separate Sites build and disabled legacy listeners.

This block does not start a listener, real PostgreSQL, credential store, native agent/provider, browser,
deployment or merge. Server rendering and in-process HTTP tests are not observed browser-click acceptance.
Real task dispatch -> artifact -> owner review and the private-beta exit remain unfinished C-WORK delivery.
