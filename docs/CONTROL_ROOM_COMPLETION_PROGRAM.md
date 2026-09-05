# Control Room completion program — private daily use

**Updated:** 2026-09-04

**Owner direction:** Implement the Astra reassessment; resume repository building.

**Completed locally:** CR14A — architecture and delivery rebaseline; see `CR14A_ACCEPTANCE.md`.

**Next block:** CR14B — bounded startup/pool and database-role implementation. The foundation,
ordinary-project private app and shared ordinary/Idea catalog with pagination are accepted; see
`CR14B_FOUNDATION_ACCEPTANCE.md`, `CR14B_PRIVATE_APPLICATION_ACCEPTANCE.md` and
`CR14B_SHARED_PROJECT_CATALOG_ACCEPTANCE.md`. Idea lifecycle remains read-only in the private view;
the owner-only private connection read view is accepted in `CR14B_PRIVATE_CONNECTION_ACCEPTANCE.md`.
Startup/role preparation is design only; full B-WIRE and private-pilot exits remain incomplete.

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
Keep Astra Xhigh for architecture/security/integration decisions; Sol High for substantial settled implementation;
Terra High for bounded UI and mechanical work. Do not change the owner's model automatically.
Exact model/effort pairs for handoffs are `gpt-6-astra` / `xhigh`, `gpt-5.6-sol` / `high`, and
`gpt-5.6-terra` / `high`. Recheck availability when dispatching; these names do not assert a worker's installed model.

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
Startup/pool/role preparation is documented in `CR14B_BOOTSTRAP_DATABASE_PREPARATION.md`; implementation,
IdP/MFA, real PostgreSQL, listener/static/browser rehearsal and deployment are not accepted by these code tests.
The project UI packet is a retired non-claimable draft; the three remaining drafts are not dispatched.

### CR14C/D — useful work first, then more machines

- C-ADAPTER: freeze a versioned Hermes native-run adapter and its contract recordings; prove exact
  profile/session identity, idempotency capability, state mapping, bounded event handling and exact-ID stop.
- C-WORK: wire canonical project request -> job -> attempt -> node-local admission -> Hermes run ->
  normalized progress/result/artifact -> review. Keep cost estimates distinct from enforceable budgets.
- CR14C-REVIEW-UI-001: build the result/revision view under the frozen presentation contract.
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
block is **remaining B-WIRE private connection view and bootstrap preparation**, using
**Astra Xhigh (`gpt-6-astra`, `xhigh`)**. Shared project reads/pagination are accepted in
`CR14B_SHARED_PROJECT_CATALOG_ACCEPTANCE.md`; source-specific Idea writes are not enabled by that acceptance.
Publish only the unimplemented prepared worker packets after their base
and shared contract are available; no extra owner message is needed for ordinary already-scoped code work.
Stop before live credentials, host changes, provider calls, database services or deployment without the
corresponding explicit scoped authority.
