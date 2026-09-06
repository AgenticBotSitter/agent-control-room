# Control Room completion program — private daily use

**Updated:** 2026-09-05

**Owner direction:** Implement the Astra reassessment; resume repository building.

**Completed locally:** CR14A — architecture and delivery rebaseline; see `CR14A_ACCEPTANCE.md`.

**Next block:** CR14C C-WORK — authenticated session ownership and runtime evidence
routing, then recovery and owner signing, on Astra Medium. Result registration
and submission ownership is accepted in PR #337; the initial owned evidence receiver
is independently statically reviewed and locally integration-tested.
See `CR14C_NATIVE_EVIDENCE_RECEIVER_ACCEPTANCE.md`. Upstream workflow
completion remains a separate unresolved gate; draft PR #329 is excluded. Exact optional
quality/completion coordinator mounting is independently reviewed in
`CR14C_QUALITY_COORDINATOR_ACCEPTANCE.md`; it is not a background event router or live fleet.
Bounded project-scoped saved-result discovery is also independently reviewed in
`CR14C_QUALITY_SWEEP_ACCEPTANCE.md`: the optional internal tick reuses exact quality
reconciliation, but periodic scheduling and live runtime activation remain unconfigured.
Durable owner-requested revision planning is independently reviewed in
`CR14C_REVISION_PLANNING_ACCEPTANCE.md`: optional two-role startup creates one linked
proposed successor from exact result/review evidence. Revised-result binding, submission,
protected reads/review and child-only quality completion are now independently reviewed in
`CR14C_REVISED_RESULT_ACCEPTANCE.md`. The executable reader accepts the authenticated v2
plan; actual producer identities remain distinct from the shared logical review subject.
This is a synthetic two-job lifecycle, not an activated runtime. Verified lease-only release
before quality approval is now independently reviewed in `CR14C_NATIVE_CAPACITY_RELEASE_ACCEPTANCE.md`.
It preserves old job/attempt/result evidence while freeing canonical capacity. Later quality
completion verifies the recorded release rather than rewriting it; revision planning and
assignment after pending release fit the unchanged capacity in disposable tests.
The protected owner revision-planning interface is independently reviewed in
`CR14C_OWNER_REVISION_INTERFACE_ACCEPTANCE.md`: the saved review now prepares or
reconciles one linked proposed task through the bounded two-role coordinator. Exact
pending requests survive result closure and lost replies in page-owned state. Separate
assignment/approval and a live runtime are still required; no native start is implied.
The supplied-database native quality/completion operation is independently reviewed in
`CR14C_NATIVE_QUALITY_COMPLETION_ACCEPTANCE.md`; no running fleet is inferred. Optional human result checks are
independently reviewed in `CR14C_RESULT_VERIFICATION_ACCEPTANCE.md`; they are not a mandatory owner
stop on every task or a replacement for automated verification. Owner resumed internal parallel
delivery; see `CR14_PARALLEL_DELIVERY_BATCH.md` for progress routing, lifecycle testing, ABS digest and
host preparation documentation. No live task or deployment is accepted by that batch.
Stored input to existing native admission/run control is independently accepted in
`CR14C_NATIVE_EXECUTION_HANDOFF_ACCEPTANCE.md`, with synthetic transport only. No live task acceptance.
Verified two-pool startup and native task approval binding are independently accepted in their CR14C
acceptance records. The start/live-read local authority composition is independently accepted in
`CR14C_NATIVE_START_AUTHORITY_ACCEPTANCE.md`, including atomic effect capacity and bounded unresolved
checks. It is unwired and fake-transport tested; stop/post-deadline permission and real resolver sources
are not yet connected. Separately signed exact-run recovery composition is now accepted in
`CR14C_NATIVE_RECOVERY_AUTHORITY_ACCEPTANCE.md`, fake-tested without renewal or stop replay;
real permission issuance and runtime sources remain unconfigured. These component acceptances do not
complete live C-WORK.
Initial native lease evidence from accepted signed commands and current owner-pinned server trust is
independently accepted in `CR14C_NATIVE_LEASE_EVIDENCE_ACCEPTANCE.md`. Other current policy sources,
owner approval trust/custody and actual handler/runtime composition remain unconfigured.
The immutable separate owner-public-pin ApprovalTrustStore implementation is now independently accepted
in `CR14C_OWNER_APPROVAL_TRUST_ACCEPTANCE.md`. This supplies scoped public verification, not installed
owner configuration, signing custody, authenticated rotation or runtime activation.
Current-policy store composition and freshness fencing are independently accepted in
`CR14C_NATIVE_CURRENT_POLICY_ACCEPTANCE.md`. Native profile/key evidence remains explicitly synthetic
in tests; no handler, live agent or runtime registration is enabled by this component.
Current recovery-policy composition is independently accepted in
`CR14C_CURRENT_RECOVERY_POLICY_ACCEPTANCE.md`, joining scoped owner pins to explicit node-local
cleanup/credential state with freshness fences. This does not implement the persistent local-state
service, qualify credentials/profiles or activate recovery requests against a real agent.
The native profile-evidence verifier is independently accepted in
`CR14C_NATIVE_PROFILE_EVIDENCE_ACCEPTANCE.md`. It consumes owner-signed acceptance and current trusted
supervisor state for an exact enrollment, with rollback/freshness fences in both controllers. It is not
the physical qualification, evidence signer/intake or supervisor implementation; those remain required.
Paired native task approval validation is independently accepted in
`CR14C_NATIVE_APPROVAL_INTAKE_ACCEPTANCE.md`. It validates exact start and bounded recovery signatures,
without signing or admitting work. Authenticated intake routing/canonical storage, owner signing custody,
supervisor persistence and dispatch remain unimplemented; this is not a working approval UI.
Canonical unsigned approval preparation is independently accepted in
`CR14C_CANONICAL_APPROVAL_PREPARATION_ACCEPTANCE.md`. Current owner permission and locked canonical
plan/reservation/node/key reads replace caller-supplied records. Shared pure contracts keep application
code outside the native adapter implementation. This does not persist an approval, sign or dispatch.
The follow-up canonical packet store is independently accepted in
`CR14C_CANONICAL_APPROVAL_STORAGE_ACCEPTANCE.md`: exact verified owner signatures are persisted under
current canonical locks with replay/conflict and commit-time fences. Migration0047 adds coordinator-only
immutable evidence (133 tables), not consumable execution authority. Bounded lifecycle/browser intake,
signing custody and actual dispatch remain; no live task has started.
The optional bounded approval lifecycle and historical receipt readback are independently accepted in
`CR14C_APPROVAL_LIFECYCLE_ACCEPTANCE.md`. They reuse coordinator admission/drain guards and allow
current owners to reconcile a saved packet after expiry or a lost reply without resubmission. The HTTP/page
and optional two-pool startup mounting are reviewed in `CR14C_PRIVATE_APPROVAL_INTERFACE_ACCEPTANCE.md`.
That panel imports already-signed files and explicitly says integrated signing is unavailable. Signing
custody and dispatch remain; historical evidence cannot authorize work.
The exact coordinator role/schema gate is independently accepted in
`CR14C_COORDINATOR_DATABASE_ACCEPTANCE.md`; migration 0046 preserves the web write profile and
adds inert coordinator locks plus a domain-transition-only outbox guard. This is not database setup.
Supplied-resource coordinator lifecycle is independently accepted in
`CR14C_TASK_COORDINATOR_LIFECYCLE_ACCEPTANCE.md`; bounded two-resource admission/drain composition
does not verify production roles or activate the deployment bootstrap.
Canonical task assignment/expiry and its protected machine-selection interface are independently accepted
in `CR14C_TASK_ASSIGNMENT_ACCEPTANCE.md`. This records reservations, not native starts or stop proof;
production composition is still unconfigured.
Protected task preparation is independently accepted in `CR14C_TASK_PLANNING_INTERFACE_ACCEPTANCE.md`;
the optional page/API operation does not enable production planning or live execution. Initial planned
result submission and owner-authorized execution planning are accepted in their separate CR14C records.
Owner quality acceptance and private change requests are independently accepted in
`CR14C_OWNER_RESULT_REVIEW_ACCEPTANCE.md`; no revision dispatch or live activation is implied.
Native result capture/readback and private file/recorded-review views are independently accepted in
`CR14C_PRIVATE_TASK_RESULTS_ACCEPTANCE.md`. This connects checked artifact bytes and existing Completion
Gate evidence in disposable tests; physical upload, revision submission and live dispatch remain unfinished.
The private task workspace is independently accepted in `CR14C_PRIVATE_TASK_WORKSPACE_ACCEPTANCE.md`:
protected project task pages save real non-running canonical proposals and show recorded attempts/native
progress. Saving is not a live assignment; owner commands are connected by the subsequent owner-review block.
The evidence path is independently accepted in `CR14C_CANONICAL_NATIVE_PROGRESS_ACCEPTANCE.md`: native
snapshots reach exact canonical harness records through durable signed delivery in disposable tests.
This evidence-only block does not itself complete dispatch, artifact verification, owner review or live C-WORK acceptance.
The supported Hermes native-run adapter is independently accepted as an unwired component in
`CR14C_NATIVE_RUN_ADAPTER_ACCEPTANCE.md`; no real agent is connected and full C-ADAPTER/live C exit remains gated.
Repository disposable fixture/preparation handoff is accepted in `CR14B_FIXTURE_PREPARATION_ACCEPTANCE.md`;
real database preparation/rehearsal/pilot remain gated, not completed.
The SQL/application rehearsal tooling is accepted in `CR14B_DATABASE_REHEARSAL_ACCEPTANCE.md`; it has not
run against a real database. The foundation,
ordinary-project private app and shared ordinary/Idea catalog with pagination are accepted; see
`CR14B_FOUNDATION_ACCEPTANCE.md`, `CR14B_PRIVATE_APPLICATION_ACCEPTANCE.md` and
`CR14B_SHARED_PROJECT_CATALOG_ACCEPTANCE.md`. Idea lifecycle remains read-only in the private view;
the owner-only private connection read view is accepted in `CR14B_PRIVATE_CONNECTION_ACCEPTANCE.md`.
Bounded startup, pool/drain and restricted roles are accepted in `CR14B_PRIVATE_STARTUP_ACCEPTANCE.md`.
The private Node request/static/service code is accepted in `CR14B_PRIVATE_SERVING_ACCEPTANCE.md`.
No database/listener was provisioned; full B-WIRE and private-pilot exits remain incomplete.

**Scope:** Finish a useful private Control Room before optional specialist expansion and public release.

## Authority and evidence

This is the current delivery program. It supersedes the sequencing and model assignments in the
[archived completion program](archive/CONTROL_ROOM_COMPLETION_PROGRAM_2026_08_26.md) and the historical
phase map in `CR3_BUILD_PLAN.md`, not accepted security invariants or immutable review evidence.
`CR14A_INTEGRATION_DIRECTION.md` and ADR-202 define the narrowly scoped integration amendment.
`BUILD_STATUS.md` records current evidence and the next block. Prior acceptance remains valid only for
the exact product and scope it actually tested. A new transport does not inherit an old qualification.

The user authorized this repository correction, not a live installation, credential read, provider call,
database provisioning, service start, DNS change, deployment, or public release. Those effects remain
explicitly scoped owner gates. No new live permission is inferred from this plan or from a draft jobber.

## What finished means

| Level | Evidence required | What it does not mean |
|---|---|---|
| Designed | Reviewed interface, ownership, acceptance and dependencies | Code exists or an effect is permitted |
| Component tested | Implemented code passes the named deterministic checks | The application uses it or a real host works |
| Connected locally | Mounted application uses the real local service/store; sample data is clearly separate | VPS or multi-machine acceptance |
| Live validated | Exact authorized runtime/host path completes the named real journey with retained sanitized evidence | Unattended release or broader permissions |
| Daily-use accepted | Live journeys, monitoring, recovery and upgrade/rollback checks pass for the declared supported fleet | Public distribution or support for untested platforms |

Do not report a phase as complete because every mock passes. A component may land early, but its parent
feature remains incomplete until application integration and the phase's user-visible acceptance pass.
No feature silently substitutes fixtures, zero counts, or invented bot responses when a live source fails.

## Owner requirements and current gaps

Baseline audited at `17d8a14499d2bdd517bb3b632e3f2501bb4cee88` (source inspection, not a new live test).

| ID | Requirement | Baseline | Delivery |
|---|---|---|---|
| R01 | Create arbitrary projects and open each in its own page/tab | Fixture routes and local Idea-promoted projects only | CR14B |
| R02 | Complete/archive/reopen projects without losing history; closing a view does not cancel work | Local Idea-project lifecycle only | CR14B |
| R03 | Normal private login with password-manager-friendly MFA and remembered sessions | 15-minute loopback pilot session, not production login | CR14B |
| R04 | Public informational homepage, separate unlinked private app, no public agent/DB endpoint | Domain inventory and fixture app only | CR14B + LANDING lane |
| R05 | Approved access at home/phone and an employer-approved work access option | No deployed topology or alternate-origin policy | CR14B; work alias may remain blocked |
| R06 | One real task, agent progress, artifact/result, review and revision from the website | GitHub queue is real; mounted Control Room execution is not | CR14C |
| R07 | Mac/Windows/Linux fleet with separate Hermes/Codex identities and scoped credentials | Contracts and platform-specific partial evidence | CR14D |
| R08 | Multiple independent jobs in flight; submit then continue; blocked jobs visible | GitHub V2 supports this; Control Room loop disabled | CR14D |
| R09 | Multi-bot ideas -> owner decision -> normal monitored project and proposed work | Repository-fake local flow | CR14E |
| R10 | ABS fresh news -> research/setup/comparison/draft task -> reviewed result | Synthetic news and local proposal editor | CR14F |
| R11 | Recurring work, budgets, capabilities, model/effort and skills visible before claim | Component-tested scheduling/packages, not live orchestration | CR14D + CR14G |
| R12 | Reconnect and rolling updates without duplicate jobs or mandatory browser shutdown | Local/fake contracts; fleet proof absent | CR14C basics + CR14G fleet proof |
| R13 | Private Hostinger PostgreSQL authority, backups, tested restore, R2 artifacts only | Schema/rehearsal contracts, no live production DB acceptance | CR14B + CR14G |
| R14 | Shared attention inbox, evidence, costs where observable, review and safe approvals | Component-tested/read-only projections | CR14C + CR14D |
| R15 | Content Blooms and Wayfarer remain supported consumers, not core architecture | Synthetic/disabled project packs | CR14H specialist lanes |
| R16 | Later public source and packages with licensing/provenance/support documentation | Prior preparation; publication disabled | CR14H public lane |

Closing a browser tab is a display action; project archive and cancellation are distinct commands.
Each project has Overview, Inbox, Work, Agents, Automations, Files, Reviews, Activity and Settings.
Project creation must not require an Idea Lab conversation or an engineer-written adapter for ordinary projects.

## Delivery phases and models

These settings are project allocation decisions, not performance guarantees. Current model roles were
checked against [official OpenAI guidance](https://developers.openai.com/api/docs/models/compare).
Current allocation update (2026-09-05): start multi-module integration on Astra Medium; use Sol
Medium/High for settled backend implementation and Terra Medium for routine UI/docs. Higher effort is
an escalation for a specific unresolved decision or demonstrated difficulty, not an automatic integration
requirement. The owner selected Astra Medium for planned result submission and the next integration block.
Do not change the owner's model automatically. The phase table below retains the original allocation;
this update and `BUILD_STATUS.md` govern current handoffs. Recheck available settings when dispatching;
these recommendations do not assert a worker's installed model or guarantee performance.

| Phase | Main work | User-visible exit | Lead setting |
|---|---|---|---|
| CR14A | Reconcile plan, architecture, truth labels, upstream reuse and worker batches | One actionable program with no false ready/live claims | Astra Xhigh |
| CR14B | VPS Node build, shared auth boundary, general project catalog/lifecycle, PostgreSQL preparation/rehearsal | Sign in to the private app, create/open/archive/reopen a durable project; restore it in a disposable rehearsal | Astra Xhigh integration; Sol High code |
| CR14C | First supported Hermes adapter and canonical task/result/review wiring | One real bounded task completes from the project page; progress and result survive browser reconnect; review/revision works | Sol High; Astra Xhigh boundary review |
| CR14D | Remaining host/harness adapters, capacity-aware claims, continuous pickup, skills and attention | Named supported fleet handles independent tasks concurrently; submission frees capacity; failures reach triage without owner message relay | Sol High; host agents validate |
| CR14E | Real bounded multi-bot Idea Lab | At least two real selected bots contribute; owner-approved synthesis becomes a normal project with proposed initial work | Sol High |
| CR14F | ABS collectors, curation, durable article actions, draft/review pipeline | A current sourced article creates a real research/setup task and a reviewable artifact | Sol High; Terra High UI |
| CR14G | Recurring operations, version negotiation, canary upgrades, recovery, monitoring and retention | Sustained multi-machine private trial; interruption/upgrade/rollback and backup/restore evidence accepted | Astra Xhigh integration; Sol High code |
| CR14H | Specialist consumers; later public source/packages | Each consumer has its own live acceptance; public release has a separate go/no-go | Sol High; Astra Xhigh release review |

## Dependency order, with parallel lanes

CR14A unlocks the repository implementation lanes below. Core operational order is
CR14B -> CR14C -> CR14D -> CR14G. CR14E depends on the shared project/job/adapter services from B/C
and two qualified participants; it need not wait for every operating system or Codex route in D.
CR14F depends on B/C for real task submission; deterministic curation and presentation can start earlier.
CR14G's daily-use gate requires D, E and F, but its backup, reconnect and update code starts with B/C.
LANDING can be prepared independently after A. Publishing it is separate from deploying the private app.
CR14H does not block private daily use. No Claude/Telegram/Unreal/public-package prerequisite is imposed
on the first generic project + Hermes task workflow.

### LANDING — independent public information lane

| ID | Owner | Deliverable | Acceptance / prerequisite |
|---|---|---|---|
| LANDING | Worker implementation; Codex copy/access review; owner publication | Small responsive informational page for `agentcontrolroom.xyz`: what Control Room is, intended uses, and coming soon | After A, under a published bounded capsule: accessible mobile/desktop layout, no private-app links or routes, no login/agent controls, no private data/cookies, and no claim the private beta or public repository is released. DNS/hosting/publication require their own scoped approval; do not invent a public GitHub link. |

The public page can ship independently of the private application. Its existence or publication does not
make the private app discoverability-resistant, authenticated, deployed, or operational.

### CR14B — one integrated foundation batch

| ID | Owner | Deliverable | Prerequisite |
|---|---|---|---|
| B-RUNTIME | Codex | Explicit VPS Node build profile; preserve existing Sites preview; no D1 authority or unverified hosting-header fallback | A |
| B-AUTH | Codex | Common verified-identity boundary for pages, APIs and streams; revocation and session policy; safe return paths | A |
| B-PROJECT-API | Codex | General project creation/catalog/lifecycle over canonical PostgreSQL, server-derived owner/tenant scope, idempotency and audit | A |
| CR14B-PROJECT-UI-001 | Codex; worker draft retired | Project catalog and creation form implemented before any worker claim | Accepted in `CR14B_PRIVATE_APPLICATION_ACCEPTANCE.md`; do not dispatch duplicate work |
| CR14B-CONNECTION-UI-001 | Worker | Clear connection onboarding/status presentation and tests, without credential or connect authority | Published capsule and accepted claim |
| B-WIRE | Codex | Mount accepted UI against B-AUTH/B-PROJECT-API; replace fixture dependence only in the explicit operational profile | B-RUNTIME, B-AUTH, B-PROJECT-API, PROJECT-UI |
| B-DB-PREP | Codex + owner | Scoped database/host preparation, backup/restore setup and private network evidence | B-RUNTIME design; separate effect packet |
| B-DB-REHEARSE | Codex + owner | Disposable real PostgreSQL migrations, concurrency, restore, restart and cleanup evidence | B-DB-PREP prerequisite evidence |
| B-PILOT | Codex + owner | Private deployed sign-in/project acceptance | B-WIRE, B-DB-REHEARSE, explicit deployment authority |

B-PROJECT-API freezes the wire API and browser controller before B-WIRE. The worker components are
controlled presentation components; they cannot choose authentication, persist a second catalog, or turn
callbacks into authority. Their separate commits are not reported as a delivered live feature.

B-WIRE now has an accepted compiled ordinary-project route tree, shared authentication/session composition,
project pages and SQL commands. The accepted shared catalog now adds owner-only authenticated Idea reads
and 50-record pagination. Private Idea commands remain CR14E integration. The private connection view now
reads the existing owner-only enrollment registry and authenticated signal receipts, explicitly not a live fleet.
Startup/pool/role code is accepted in `CR14B_PRIVATE_STARTUP_ACCEPTANCE.md`, including explicit configuration,
role/schema preflight and uncertain-outcome handling. The database TEMP simulator limitation is explicit;
real DB permissions/concurrency are not accepted by the injected metadata test. The private Node request/static
adapter is now accepted with injected lifecycle and compiled SQL tests. The operator SQL/application rehearsal
tooling is now accepted with synthetic/disposable tests and explicit pool-reopen/evidence limits. Its separate
fixture-preparation entry is also accepted: empty-database/schema gate, one joined seed transaction and fresh
one-use private handoff, with no native setup or service run. Continue unblocked C-ADAPTER/C-WORK code next.
IdP/MFA, real PostgreSQL, physical listener/static/browser
rehearsal and deployment retain their separate readiness/authority gates.
The project and review UI packets are retired non-claimable drafts; the two remaining drafts are not dispatched.

### CR14C/D — useful work first, then more machines

- C-ADAPTER: freeze a versioned Hermes native-run adapter and its contract recordings; prove exact
  profile/session identity, idempotency capability, state mapping, bounded event handling and exact-ID stop.
- C-WORK: wire canonical project request -> job -> attempt -> node-local admission -> Hermes run ->
  normalized progress/result/artifact -> review. Keep cost estimates distinct from enforceable budgets.
  The private canonical proposal/task page and recorded native progress path are accepted repository blocks;
  checked result content and explicit owner quality/change-request commands are accepted too. Remaining work:
  bounded executable planning/admission/dispatch, physical artifact transport and planned target/revision submission.
  Bind the acceptance profile in trusted planning; never initialize a target on a UI read or broaden an inert
  proposal envelope. Reuse real native evidence rather than synthetic execution-start events.
- CR14C-REVIEW-UI-001: retired undispatched draft; the accepted private-app result/review implementation
  supersedes the older presentation-only interface. Do not dispatch duplicate work.
- C-REHEARSE: one scoped real useful task on one prepared host, plus reconnect and uncertainty handling.
  Do not wait for macOS-specific credential issues if another explicitly qualified route can do the task.
- D-FLEET: add Mac, Windows and Linux host evidence separately; unsupported routes stay visibly unavailable.
- D-CODEX: add the separately reviewed native Codex adapter; no provider-credential sharing with Hermes.
- D-QUEUE: move only Control Room-native jobs to the PostgreSQL scheduler; implement continuous pickup,
  platform/capability checks, route limits, fair sharing, no double claims, blocked-work triage and batch review.
- D-SKILLS: expose reviewed worker instructions/packages and model/effort requirements before assignment;
  do not inherit all tools/MCP servers/plugins from a personal agent profile.
- D-MCP: expose the same scoped job/project/review services as MCP tools; MCP is not a second scheduler.
- D-CUTOVER: retire bootstrap authority per job class with a recorded cutover; never run GitHub and
  PostgreSQL as simultaneous independent claim authorities for the same work.

### CR14E/F — owner workflows, not standalone demo panels

- E-ROOMS: select real profile/device participants, preserve useful private conversation content with
  project access/retention policy, and show attribution, progress, limits, cancellation and unavailable bots.
- E-PROMOTE: approve/reject/revise synthesis, create a normal project, propose initial jobs, preserve lineage.
  A bot conversation or peer message never grants a lease or authorizes a consequential effect.
- CR14F-NEWS-CORE-001: deterministic source diversity/relevance selection under the frozen contract.
- F-COLLECT: scoped approved public RSS/Atom sources, safe collection, provenance, freshness, deduplication,
  manual inputs and archive persistence. Newsletter credentials are a separate optional connection.
- F-WORK: Research / Setup Guide / Compare / Draft actions materialize durable reviewed work and show
  the resulting job, agent, artifact and revision in the ABS page. Source text remains untrusted input.
- F-PUBLISH: separate destination-specific authorization, idempotency and publication acceptance; the
  private beta can deliver approved drafts before public publishing is enabled.

### CR14G/H — daily use and later expansion

- G-RECOVER: restart reconciliation, bounded event replay or explicit resnapshot, stale/offline truth,
  backup monitoring, real restore and incident/action-inbox proof.
- G-UPDATE: minimum/current protocol versions, admission drain, existing-run reconciliation, immutable
  release identity, compatible migrations, one-host canary, rollback and later fleet rollout.
- G-TRIAL: a 24-hour proposed supported-fleet trial with representative scheduled and manual work;
  owner-visible result/review, a deliberate reconnect, and a staged update without duplicate work.
  This duration is a release criterion, not permission to create an unattended automation now.
- G-ACCEPT: verify R01-R14; record explicit exceptions such as an unapproved work-computer alias or
  disabled public publishing. Core task, access, recovery and authority failures cannot be waived as polish.
- H-CB / H-WF: finish the existing consumer-specific source boundaries, real rehearsals, storage and
  publication/delivery gates; retain source-scheduled ownership for Content Blooms.
- H-PUBLIC: provenance/license audit, supported-version matrix, secret/artifact review, clean install,
  documentation and separate repository/package/publication approval. Static coming-soon is not this gate.

## Break the rehearsal prerequisite loop

Existing AUTO-100/110 contracts are retained, not marked passed or silently made permissive.
B-DB-PREP must introduce an architect-reviewed successor packet that explicitly separates:

1. **Before preparation:** exact target/scope, owner authority, private access path, isolation, resource
   bounds, cleanup/rollback plan, and no pre-existing data overwritten.
2. **Produced by preparation:** observed PostgreSQL version/service, roles, private binding, backup/WAL
   configuration and disposable restore target.
3. **Before rehearsal:** those preparation observations and authority for the exact test workload.
4. **Produced by rehearsal:** restore/concurrency/migration/restart/cleanup evidence.
5. **Before daily use:** accepted rehearsal, deployed auth, monitoring and rollback readiness.

A test must not require its own success evidence as an input. Each evidence item names the earlier packet
that produces it. Existing same-UID/administrator exclusions and compromised-server containment remain explicit.

## Worker wave and owner involvement

The first four substantial worker capsules are prepared in wave `CR14-PRIVATE-UI-1` under
`coordination/agent-build/`. They are **draft, local and not claimable**. Their product paths do not overlap;
their combined work is paired with the named Codex integration tasks above. A draft validator pass means
structural completeness only, never readiness, an accepted claim, or a live-feature pass.

Before publication: integrate the frozen UI contract, inspect current work/branches, confirm the exact base,
create the named integration branch, validate capsules as ready, publish canonical issues and wait for
`CLAIM ACCEPTED`. Use existing known route identities only; do not invent installed models or host readiness.
Check the wave and every capsule's lifecycle together before publishing: the current capsule validator does
not independently consult wave status. Preserve the draft-rejection regression with a draft fixture when
updating the wave's draft-state snapshot tests for a deliberate ready transition. A changed label alone is
not publication, an integration-base check, or a claim.
Workers may hold up to three independent claims per route and continue after submission. Ordinary code
has two focused repair iterations; an uncertain native or external effect never gains a retry from that rule.
T0/T1 admission is based on the real task and prerequisites, not a separate qualification exercise.

Codex owns architecture, migrations, auth, interfaces, effect admission, integration and final review.
Workers deliver isolated settled code/tests/UI. Independent review is required when specified and focuses
on meaningful changes to authority, concurrency, data integrity and cross-module behavior.
Do not apply the full controlled-effect process to ordinary local UI or documentation changes.

## Reporting and next block

Every block reports: implemented result, evidence level, mounted integration, remaining live blockers,
tests actually run, and the next block/model. Keep historical evidence separate from current readiness.
No fresh calendar/percentage completion claim is made until the first real connected workflow is measured.

CR14A is accepted for planning and coordination tooling; see `CR14A_ACCEPTANCE.md`. The CR14B foundation is
accepted for component/in-process integration; see `CR14B_FOUNDATION_ACCEPTANCE.md`. The ordinary-project
private application is also accepted; see `CR14B_PRIVATE_APPLICATION_ACCEPTANCE.md`. The next architect
block is **CR14C trusted native evidence receiver ownership**, using
**Astra Medium (`gpt-6-astra`, `medium`)**. Planned initial result submission and owner-authorized execution
planning are accepted in their separate records; neither dispatches tasks or revisions. Protected page/API
planning and canonical assignment/expiry are now optionally mounted without changing web SQL privileges;
supplied-resource ownership is accepted in `CR14C_TASK_COORDINATOR_LIFECYCLE_ACCEPTANCE.md`.
The coordinator role/schema gate is accepted in `CR14C_COORDINATOR_DATABASE_ACCEPTANCE.md`.
Verified two-pool bootstrap mounting is accepted in `CR14C_VERIFIED_TASK_STARTUP_ACCEPTANCE.md`.
Actual signed admission/dispatch and real deployment configuration remain; no live startup is claimed.
Protected owner revision preparation and the optional three-role result writer are now
independently reviewed in `CR14C_OWNER_REVISION_INTERFACE_ACCEPTANCE.md` and
`CR14C_RUNTIME_RESULT_OWNERSHIP_ACCEPTANCE.md`. The writer registers actual initial/v2
review bindings and submits verified saved bytes, without job transitions or quality approval.
Migration0055 retains138 tables and adds a narrow native-result role/guard; existing
web/coordinator grants remain unchanged. Next, give the existing authenticated run,
progress and capture services bounded receiver ownership so tests no longer need
privileged fixture preparation for those steps. Physical services remain separately gated.
Exact native payload/approval/effect binding is accepted in `CR14C_NATIVE_TASK_APPROVAL_BINDING_ACCEPTANCE.md`.
Node-side NativeAuthority, current-policy checks, durable claim/marker ordering, paired signature intake
and canonical unsigned preparation are now independently accepted. Owner HTTP/page signed-file intake
and startup mounting have independent review. Current saved-packet revalidation is independently reviewed
in `CR14C_SAVED_APPROVAL_REVALIDATION_ACCEPTANCE.md`. Atomic approved-task queue insertion and audit
are independently reviewed in `CR14C_APPROVED_TASK_QUEUE_ACCEPTANCE.md`; migration0048 brings the
canonical schema to134 tables without adding web permissions. Signed delivery processing and node
receipt/reconciliation are next. Exact native delivery/receipt protocol and local-enrollment intake
handoff are reviewed in `CR14C_NATIVE_DELIVERY_PROTOCOL_ACCEPTANCE.md`; no sender/handler or feature
advertisement is activated. Durable exact unsigned body preparation/history is reviewed in
`CR14C_DURABLE_DELIVERY_PREPARATION_ACCEPTANCE.md` (migration0049/135 tables). Current connection
checks, server signing, delivery progress and node acknowledgement remain next.
The node-side negotiated/reconciled channel gate is independently reviewed in
`CR14C_NATIVE_CHANNEL_ACCEPTANCE.md`; old queued control sends cannot migrate across reconnect.
This is connection-state evidence only. Server-side negotiation and actual sender/receiver remain.
Server-side signed negotiation with the actual bridge is now independently reviewed in
`CR14C_SERVER_NODE_SESSION_ACCEPTANCE.md`, including bounded single-process replacement ownership.
Long-lived session renewal/routing and durable task sending/receipts remain; no live transport is mounted.
Exact signed envelope staging under the current canonical transaction is independently reviewed in
`CR14C_DURABLE_ENVELOPE_ACCEPTANCE.md` (migration0050/136 tables). This reserves and stores a frame but
does not transmit it. One-shot transmission intent/transport integration is independently reviewed in
`CR14C_NATIVE_TRANSMISSION_ACCEPTANCE.md` (migration0051/137 tables): intent commits before send,
authorization time fences survive commit, and uncertain outcomes never retry. Authenticated receipt
persistence is now independently reviewed in `CR14C_NATIVE_RECEIPT_ACCEPTANCE.md` (migration0052/138
tables). Exact session-authenticated receipts are stored with audit and current key/time checks; they
report node intake claims, not execution proof. Node intake/admission, receipt production/acknowledgement
and runtime routing/recovery remain; no live task delivery is claimed. The optional node bridge intake
and actual signed receipt production are now independently reviewed in
`CR14C_NODE_NATIVE_INTAKE_ACCEPTANCE.md`. This verifies local enrollment and separate owner signatures,
records bounded append-only node input and returns a receipt without execution. Current-policy admission
and native run handoff, acknowledgement/recovery, resource replacement and live mounting remain.
Revalidation and insertion share a transaction; returned
snapshots and historical receipts cannot authorize later delivery. Bounded approval lifecycle
and historical reconciliation are accepted. Integrated owner signing and custody, durable
supervisor state and revision submission remain; no application import of the native adapter is permitted.
See `CR14C_TASK_ASSIGNMENT_ACCEPTANCE.md`.
See `CR14C_TASK_EXECUTION_PLANNING_ACCEPTANCE.md` and `CR14C_TASK_PLANNING_INTERFACE_ACCEPTANCE.md`. Shared project reads/pagination are accepted in
`CR14B_SHARED_PROJECT_CATALOG_ACCEPTANCE.md`; source-specific Idea writes are not enabled by that acceptance.
The connection read view, startup/role, serving, rehearsal and fixture-preparation code are accepted in their
CR14B acceptance records. Owner quality commands are accepted in `CR14C_OWNER_RESULT_REVIEW_ACCEPTANCE.md`. The next code
block must not open a physical listener or connect/provision PostgreSQL without the separate scoped packet.
Publish only the unimplemented prepared worker packets after their base
and shared contract are available; no extra owner message is needed for ordinary already-scoped code work.
Stop before live credentials, host changes, provider calls, database services or deployment without the
corresponding explicit scoped authority.
