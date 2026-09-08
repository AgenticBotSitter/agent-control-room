# Johnny5: consolidated next deployment steps

Operator configuration and deployment procedures are now supplied. This does not
authorize production startup or resolve the shared-primary persistence problem.
Use the exact private-branch SHA supplied with this handoff as the deployment pin.

## Supplied

- `scripts/run-private-node.mjs` and the compiled `nodeConnector.js` provide an
  explicit one-task Hermes command, not a continuous service or approved live setup.
  See `packages/control-room-node-service/README.md` for the protected configuration,
  ownership, explicit recovery and evidence limits. Do not install the historical
  node service templates or substitute this command into an automatic restart loop.
  Real enrollment, persistent journals, credential/trust ports and runtime setup
  remain separately required; the Windows permission gate is not implemented.
  Its compiled `openPrivateNativeConfiguration` export now assembles the existing
  persistent journals and verified policy/transport components, reducing manual
  wiring. Use only pre-created approved private files and borrowed provisioned
  security/credential/profile ports; this is not approval to initialize a live node.

- `deploy/operator-config.mjs`: protected single-site website-only settings.
- `scripts/private-deployment-inventory.mjs`: 64 migration and web-role source hashes;
  select `--profile idea-authoring` to include the optional writer-role and native
  Idea adapter setup sources.
- `scripts/check-private-vps-database.mjs`: existing production preflight plus close,
  without application installation or a listener. It verifies both roles when the
  optional Idea-authoring profile is configured, otherwise only the web role.
- `deploy/README.md`: dedicated database/roles and initial website procedure.
- `deploy/OWNER_BOOTSTRAP.md`: compiled verifier-to-owner bridge, explicit
  `scripts/bootstrap-private-vps-owner.mjs` command and separate protected input
  module. Identity confirmation, prepared private inputs and execution remain gated.
- `deploy/BACKUP_RESTORE.md`: backup, disposable restore and evidence requirements.
- `deploy/SUPERVISION.md` and `control-room-website.service.in`: conditional systemd
  review template and maintenance update/rollback procedure, not an installed unit.
- `docs/IDEA_PROJECT_LIFECYCLE_DELIVERY.md`: changed web-role grants and lifecycle
  integration. Older prepared grants fail the new exact startup preflight.
- `docs/NEWS_COLLECTION_STATUS_DELIVERY.md` and `docs/IDEA_ROSTER_SELECTION_DELIVERY.md`:
  source-status and participant-selection integration for separately configured
  news/Idea operations, not automatic activation by the website-only settings.

The settings module now optionally accepts protected `savedViews` keys for existing
Idea/News records; see `deploy/README.md`. Omitting them keeps the minimal profile.
An optional `ideaAuthoring` writer login/roster now enables non-executing Idea
save, recap and decision operations without native-task planner setup. Both actual
database roles still require provisioning and preflight; see `deploy/README.md`.
It does not configure providers, task coordinators or native transports. Source
support is not configured operation, and saved views are not worker activation.
Do not invent keys for saved signed records or use fixture identities.

The website-only startup rejects misplaced coordinator operations, including task
approvals, submission and queue attention. These require the existing task-application
composition and its separately verified resources; adding callback fields to `web`
must not look like successful activation while the callbacks are discarded.

## Inspection before production changes

Verify the pinned checkout and source inventory; compare supplied procedures with
the actual namespace/persistent layout. Confirm whether systemd manages that exact
namespace; otherwise identify the existing supervisor. Do not install a replacement
manager or rerun unchanged accepted memory tests without a reason.

The database-check command is not an effect-free source check: it reads protected
settings and contacts a database. Run it only with authority for that exact target.
It performs preflight SELECT queries, but is not an arbitrary-SQL read-only sandbox.
For a later fully configured `agent-tasks` envelope, the same command checks all
selected task/Idea/news/worker database roles without starting those capabilities.
It does not create the full operator configuration or validate its non-database
resources. Keep its configuration factory inert and separately approved; see the
full-profile inspection section in `deploy/README.md`.

## Execution order after separate approval

1. Resolve PostgreSQL storage persistence without risking other applications.
   Review an exact backup/relocation plan before replacing a shared container.
2. Provision the dedicated empty database and separate reviewed roles; apply pinned
   migrations and current grants. Keep schema ownership separate from the web login.
   For authoring, register the native Idea adapter for the exact tenant using the
   reviewed setup procedure after that tenant exists. Preflight refuses a missing
   or mismatched registration; ordinary schema migrations alone do not create it.
3. Capture the owner's real verified Access subject through the approved login
   procedure and bootstrap only that identity. Verify issuer/audience and application
   MFA inheritance; no policy-level override does not necessarily mean MFA is off.
4. Run database-only preflight on the prepared target. Back it up, restore into a
   different disposable database and verify preflight plus required data/integrity.
   Retain the selected authoring profile during restore acceptance and retarget both
   database settings to the restore; require both role checks, not a web-only pass.
5. Review the actual supervisor, service account, persistent settings and unused
   loopback port. Obtain explicit production-start authorization.
6. Start website-only once. Verify loopback binding, denied anonymous access, exact
   Host checks and other-site health before separately approved ingress changes.
7. Owner verifies real login/MFA, projects, logout, deep links and controlled restart.
   Measure application/database memory under this small workload.
8. Schedule separate real-agent, Idea panel and news-task execution acceptance.
   Website-only success is not orchestration success.

## Return one consolidated sanitized report

For later owner acceptance of Idea promotion, open the created project's Tasks page
and choose **Prepare first experiment task** with an empty draft. Review/edit the
planning instructions and explicitly save. The result must be one proposed task,
with the source discussion/digests retained as editable context and zero attempts.
No initial task is silently saved by promotion. The preparation control requires
both task-proposal eligibility and authorized source-discussion visibility.
Do not report task execution ready merely because this works: the execution
planner uses explicitly project-pinned templates and matching acceptance profiles.
One coordinator supports up to 16 configured projects; follow
`docs/MULTI_PROJECT_PLANNING_DELIVERY.md`. New promoted
projects need separately configured execution resources, not another project's
authority copied or broadened to make the next button succeed.

Include release SHA, inventory digest, checks performed, exit codes, actual changes,
remaining prerequisites, connection/process cleanup and exact next approval needed.
Distinguish supplied procedures, local tests, host inspection and real acceptance.
Never return passwords, owner subjects, tokens, MFA secrets, private routing values
or raw database contents. No swap changes, unrelated website stops, production
provisioning/startup, ingress edits or cleanup are authorized by this handoff.
