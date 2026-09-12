# Public release plan and open contribution areas

Updated September 12, 2026. Humans, bots and mixed teams are welcome. Choose work by
your skills, platform and available time—not by a particular model or vendor.

This is the controlling public delivery plan. COMPONENT_DECISIONS.md preserves the
17 decision IDs; older comparison/progress documents are evidence at their recorded
revisions, not instructions to repeat research. Update affected rows and assignments
together when requirements change. Selection, integration and live acceptance differ.

## One product, configurable for everyone

One public core, one versioned release and one upgrade path. A maintainer's personal
installation uses the same artifact as everyone else's. Projects, worker registrations,
branding, templates, workflows, service connections and limits are configuration.
Credentials and private data stay outside the source repository. No private-only core
fork is required. Optional extensions use reviewed public interfaces and cannot grant
themselves permissions.

Prove customization by running the same artifact with two disposable configurations
and separate data stores, without source edits or rebuilding. Configuration exports
contain only documented non-secret portable fields. Upgrades preserve supported
configuration and identify incompatible extensions.

## Release outcome

A new user installs Control Room, connects two different supported harnesses, creates
project pages, assigns work, watches progress, reviews results and requests revisions.
Eligible work continues while reviews wait. Disconnects and restarts do not silently
repeat uncertain execution. Closing a project tab does not cancel its worker.

Hermes and Codex are the first integration targets. Other harness contributors are
welcome to propose adapters and reusable conformance scenarios. Extensible does not
mean every harness already works: publish tested versions and capability limitations.
Use existing upstream interfaces and selected components; explain any necessary custom
infrastructure. Do not patch an installed harness just to satisfy a synthetic contract.

This remains pre-alpha. A usable release candidate is the near-term target, not a
claim of completed live compatibility. Personal workflows, extra adapters, elaborate
scheduling and optional monitoring must not delay the first real mixed-harness loop.

## Where help makes the biggest difference

| Focus area | Difficulty / environment | Substantial outcome | Coordination |
| --- | --- | --- | --- |
| Project webpage and customization | Intermediate frontend; any OS | Project/worker pages, progress/results/revision, configurable templates, keyboard/mobile usability | [#10](../../issues/10); additional contributors welcome on reserved non-overlapping slices |
| Hermes integration | Advanced integration; Mac/Linux | Real upstream session/job mapping, progress/results and honest reconnect/capability behavior | [#8](../../issues/8), existing PR #14; coordinate before overlapping edits |
| Install, update and rollback | Intermediate/advanced tooling; Linux | Reproducible artifact, generic setup, integrity checks, documented upgrade/rollback | [#9](../../issues/9), existing PR #13; open for additional capacity with explicit handoff |
| Windows and cross-platform readiness | Intermediate platform work; Windows | Portable setup, line endings, worker constraints and browser acceptance | [#2](../../issues/2) |
| Release notices and attribution | Intermediate build tooling; any OS | Actual shipped dependency-instance/vendor coverage, original notices, packaging checks | [#11](../../issues/11), reuse useful PR #16 provenance |
| Core execution and recovery | Advanced backend; maintainer-coordinated | Admission, queue pickup, real Codex integration, durable identity and safe recovery | Propose an isolated implementation/test slice in [#12](../../issues/12); maintainer owns shared contracts |
| Independent review | Advanced in the relevant boundary | Concrete risk-focused review of execution, authorization, persistence or release candidate | Offer expertise in [#12](../../issues/12); no mandatory second review for routine UI/docs |
| Additional harness adapters | Intermediate/advanced integration | A supported upstream adapter plus conformance evidence, without another scheduler | Propose the harness and tested capabilities in [#12](../../issues/12); initial release prioritizes the first two |

These areas are not exclusive to a named bot or organization. Existing contributors
retain ownership of their active branches. Ask for a clearly separated part or a
recorded handoff; don't duplicate an existing PR. The maintainer confirms reservations
using a unique contributor/worker identifier when several bots share one GitHub login.

## Starting revision and branch transition

Public main currently contains the earlier source preview. More implementation is on
`codex/component-batch-4`, inspected at
`7b9d6782318d5d5266ea9e444cba8b67de65691b`. This documentation publication does not
merge or accept that implementation. Do not rebuild features already on that branch.

Existing PRs keep their recorded targets. Before any new implementation starts, the
maintainer records its immutable base SHA, exact target branch, owned paths and ready
dependencies. Pending baseline reconciliation, plan against the component tree above;
do not guess that main has the newer code. Once accepted work lands on main, new work
branches from it. Avoid long dependent PR stacks.

## Working together with less ceremony

Use [CONTRIBUTING.md](CONTRIBUTING.md), the
[public worker skill](skills/public-build-worker/SKILL.md) and
[public review skill](skills/public-build-review/SKILL.md).

- Choose a complete outcome—usually several hours of coherent work—not a single test.
- A maintainer-confirmed named assignment is the claim. A comment alone is not an
  atomic lock. Public assignments need no private V2 capsule/controller ceremony.
- Debug and repair ordinary code within scope without arbitrary retry counts. If
  repeated attempts produce no new evidence, report the blocker and take a different
  reserved independent item. Failed tests are not disqualification.
- Keep one active implementation and normally up to two submitted PRs. Continue
  independent assigned work while reviews happen; don't begin dependent changes early.
- Submit one concise PR: outcome, base/head, checks/results, untested limitations and
  upstream/license changes. No separate metadata commit or mandatory JSON report.
- Reviewers consolidate material findings. Cosmetic preferences are nonblocking.
  Re-review changed code and affected checks, not the entire project every round.
- Shared protocols, auth, credentials, migrations and final integration are maintainer
  decisions. Reserve shared paths early; contributors can propose improvements.
- Existing native/provider attempt limits remain binding. Ordinary debugging permission
  does not authorize deployment, credentials, persistent services or uncertain retries.
- Keep local commits and meaningful pushes. Public CI is enabled on standard hosted
  runners with read-only permissions and approval for external contributors. No
  scheduled builds, automatic deployment or privileged public-PR runners are enabled.

## Build and release sequence

1. Reconcile the public baseline and freeze small shared execution/configuration
   contracts. Request focused independent review of material boundaries.
2. Build webpage, adapters, packaging, notices and platform checks in parallel on
   reserved paths. Keep fake mode clearly labeled and connect the real product path.
3. Assemble one candidate SHA. Rehearse fresh install, two real harnesses, project
   isolation, result/revision, queued follow-up, lost reply, worker disconnect, server
   restart, denied access and bounded resource usage with disposable data.
4. Rehearse update/rollback and backup restoration into disposable storage. Verify the
   same release with two configurations and notices for its actual shipped contents.
5. Resolve material release findings, publish tested support/limitations and setup.
   If a real gate remains open, label the release a preview rather than claiming done.

Tests using fixtures are valuable but not native acceptance. Live tests need explicit
scope and the operator's own accounts; contributions grant no access to private hosts.
Track working user journeys and material blockers, not a percentage based on file or
test counts. [Issue #12](../../issues/12) is the coordination index. Posting an issue
does not itself wake or dispatch an external agent.

## Bounded evaluation, then integration

Use **integrate** when selection evidence is sufficient, **conditional fit** for a
named remaining interface/correctness question, and **deferred** outside the initial
release. Unperformed alternatives remain unperformed, not failed. Exhaustive proof
that a component beats every competitor is not a release requirement.

For conditional fit: retrieve the existing pin/code/tests and inspect relevant
upstream changes only. Test the preferred candidate across the actual application
interface with disposable data: required success plus the decisive unresolved failure
(such as lost reply/restart). Reuse equivalent evidence. Time-box initial investigation
to roughly 60–90 minutes; that does not expand native attempt or cleanup authority.
If it fits, continue straight into integration in the same work package. If it fails
a required property, test only the strongest already-known fallback against that
failure. The lead decides whether further research has enough value. Missing setup
alone does not reject a candidate; reaching the timebox does not manufacture a winner.

Record source/pin, reused API/files, checks actually run, limitations, adaptation/removal
scope and license obligation concisely. No new repository census or speculative scoring.
Custom infrastructure requires a specific requirement, demonstrated incompatibility or
excessive adaptation cost, smallest custom boundary and reopen condition. Our invented
REST envelope is not itself a reason to reject an otherwise suitable upstream MCP API.

## Reuse-to-work ledger

Pins are retained evaluation targets, not automatic upgrade instructions. Reconcile
existing component-branch code before rebuilding anything. Remaining tests below are
integration acceptance unless explicitly marked conditional fit.

| ID / responsibility | Selected source and disposition | What remains / work area |
| --- | --- | --- |
| DR-01 discussion rounds | Retain small bounded fixed-panel loop; actual Hermes planner comparison found unnecessary adaptation for this responsibility | Wire real participants and retained contributions after core execution. Dynamic planning reopens the decision only if required |
| DR-02 collection | Integrate attributed [Control Center](https://github.com/mreflow/control-center), rss-parser 3.13.0 and fast-xml-parser 5.11.0 | Existing parsing comparisons justify distinct boundaries, not another collector. Generic news/source-to-result workflow follows core |
| DR-03 dependency graph | Integrate pnpm 11.19.0 prepared graph | #11: exact release/platform identity including multiple versions and instances |
| DR-04 license texts | Integrate CycloneDX library 10.2.0 LicenseEvidenceGatherer, build-time only | #11/#9: original text, actual bundle/vendor/assets and exception provenance. Reuse PR #16 texts, not its name-only inventory as release authority |
| DR-05 token verification | Integrate jsonwebtoken 9.0.3 behind retained policy/configurable identity | Core: public caller parity, generic setup and real owner/expiry/denial acceptance. jose parked unless async/runtime needs change |
| DR-06 task authority | Retain canonical task/attempt/result/review state | Core: real execution/receipts. Actual Maestro duplicate-delivery evidence does not justify replacing immutable records; notification routing only for a named gap |
| DR-07 article extraction | Integrate [Readability](https://github.com/mozilla/readability) 0.6.0 + jsdom 26.1.0 | Existing bounded extraction tests; finish source-bound reader/resources/notices when optional news workflow ships |
| DR-08 workspaces | Integrate native Git behind existing ownership/lease port | Core/#2: restart re-adoption, contention, dirty/conflict preservation and retention. Agent Orchestrator remains selective preservation donor |
| DR-09 calendar | Integrate cron-parser 5.10.0 + Luxon 3.7.2 | Core: existing parity evidence counts; finish eligible dispatch, duplicate/missed occurrence and recovery |
| DR-10 database client | Integrate node-postgres 8.23.0 | Core/#9: reconcile existing PG/lifecycle evidence and independent findings on exact public code: client release, awaited precommit, failed-BEGIN discard |
| DR-11 results | Integrate react-markdown 10.1.0 + remark-gfm 4.0.1 in current protected panel | #10: actual parent/browser, review/revision, accessibility and attachments; no whole desktop shell |
| DR-12 sessions | Conditional optional [Herdr](https://github.com/herdrdev/herdr) pane-list | Actual disposable Mac binary/socket/reconnect/restart evidence exists. Targeted newer-source check, project mapping and selected-host isolation remain. Operator-managed; binary redistribution not cleared |
| DR-13 work engine | Integrate [pg-boss](https://github.com/timgit/pg-boss) 12.30.0 | Core: actual pg-boss/DBOS short-phase evidence exists; finish admission/replay, review-wait capacity, drain and real recovery. DBOS/Hatchet parked unless required behavior fails |
| DR-14 monitoring | Conditional [Uptime Kuma](https://github.com/louislam/uptime-kuma); optional [Beszel](https://github.com/henrygd/beszel) | Deferred external services. Kuma condition/database evidence, Beszel source evidence only. Real alerts/restart/host cost remain; existing operator monitoring can suffice |
| DR-15 rollback integrity | Conditional existing etcd adapter | Core: actual service binding exists; independent placement, restore and split-commit recovery remain. OpenBao is fallback if required permission/integrity behavior fails |
| DR-16 signing | Conditional dedicated owner signing agent using ssh2 | Core: protocol/lifetime tests exist; actual custody, exact consent and platform acceptance remain. No ambient key reuse or forwarding |
| DR-17 native execution/files | Conditional official Codex App Server and supported Hermes interfaces | Core/#8: upstream-backed fit, explicit-ID recovery, real lifecycle, bounded artifacts. Python client is viable fallback, not another mandatory contest |

Conditional signing/checkpoint work is not silently optional security work. The lead
must settle the guarantees required by the initial supported mode and satisfy them,
or explicitly narrow that mode. No deadline-driven approval/rollback bypass.

### Specific repositories: reuse, not blanket endorsement

- [hermes-gpt](https://github.com/asimons81/hermes-gpt): #8 must pin a full revision,
  check relevant changes after the prior `11db8ac` evaluation and exercise its actual
  session/job/result interface through our adapter. Account for its Codex/artifact
  APIs too, to avoid duplicating useful clients. PR #14's synthetic responses are not
  upstream execution. No required upstream fork; stop/replay capabilities must be
  proven or shown unavailable. Do not invent successful acknowledgments.
- [Herdr](https://github.com/herdrdev/herdr): evaluated source
  `b99002ac99b09e00b4ca692436cb15a6b0d676f1` supports optional observation direction,
  not newer releases, SSH, Windows or live-agent claims. If terminal hosting becomes
  required, evaluate this first instead of writing a multiplexer. Session state never
  substitutes for task completion. Do not rerun unchanged disposable tests.
- [Hermes Desktop](https://github.com/fathah/hermes-desktop) and
  [Hermes WebUI](https://github.com/nesquena/hermes-webui): #10 gets one bounded actual
  component-fit exercise for needed tabs/results/session presentation using existing
  research. Adopt only if it saves work without importing global state or Electron.
  Existing panels remain a valid smaller choice. Check exact licenses before copying.
- [Hermes Studio](https://github.com/EKKOLearnAI/hermes-studio): copying stays parked
  until source-specific licensing permits the intended distribution. Personal use
  does not justify postponing license compliance.
- Agent Orchestrator/AI Maestro remain selective workspace/notification donors, not
  a second task authority. DBOS/Hatchet/OpenBao/jose remain named fallbacks, not a
  requirement to benchmark competing stacks again.

For copied code, retain upstream project URL, immutable revision, original paths,
license/copyright/NOTICE, local destination and modifications in third_party notices.
For package use, exact lock identities and original texts flow into the release
inventory. Link from THIRD_PARTY.md. Planned donors are not claimed as incorporated.
Inspect actual bundles: development dependencies can ship. Separate operator-installed
runtimes from redistributed binaries. Never substitute our Apache license for theirs.

## All product outcomes accounted for

This covers the 26 historical outcomes. Deferred means retained on the roadmap,
not forgotten. Configuration is a cross-cutting release requirement.

| Outcomes | Scope / integration owner area | Completion evidence |
| --- | --- | --- |
| A1 website/database; A2 login | Essential: core/#9 | Generic clean setup, durable PostgreSQL, configured owner login and access denial; no personal-account dependency |
| A3 approval; A4 rollback integrity | Essential for admitted mode: core boundary review | Exact approved work, supported custody/recovery, missing or rolled-back authority refused |
| A5 task/result/revision; A7 attention | Essential: core/#8/#10 | Two real harnesses, retained results/revision; failures and uncertainty actionable |
| A6 project pages | Essential: #10 | Separate projects, lifecycle/reload/mobile/keyboard; same artifact with two configurations |
| B1 continuous fleet; B2 schedules | Queued follow-up essential; expanded schedule UI later | Bounded concurrency, review wait frees capacity, restart/drain; enabled schedules deduplicate occurrences |
| B3 Codex; B9 capabilities/usage | Essential: core/#8 | Real identities/events/results, explicit unsupported operations and unknown usage |
| B4 installation; B6 reconnect/cleanup | Essential: #9/#2/core | Documented enroll/version compatibility, no blind redispatch, owned cleanup or explicit uncertainty |
| B5 external sessions | Optional Herdr | Scoped stale/offline observations, no implicit terminal control |
| B7 team/workspaces | Essential: core/platform | Isolated checkouts, confirmed ownership, conflict/dirty preservation |
| B8 artifacts | Essential bounded result files: core/#8/#10 | Actual bytes/hash/size/type bound to project/run/attempt, protected download, no arbitrary paths |
| C1 Idea Lab; C2 promotion | Follow core loop: workflow contributors | Real bounded discussion, saved contributions and promoted project with completed first task |
| C3 news reading; C4 research | Optional generic workflow after core | Configurable sources, attribution, source-to-result/revision; no implicit publishing/setup effects |
| C5 extensions | Extension contract essential; extra adapters/packs later | Examples/conformance, version/capability limits, removable modules; no private core fork |
| D1 backup/restore; D3 updates | Essential for persistent use: #9/core | Native PostgreSQL logical tools, restored rows/roles/ACLs and matching artifacts, rollback with preserved journals; no new backup engine |
| D2 monitoring | Basic readiness essential; external tools optional | Useful health separate from job authority; optional alerts independently removable |
| D4 daily acceptance; D5 contribution | Essential: assembled release/#11/#2/#10 | Sustained bounded workload/resources, clean install, privacy/licenses, public CI and contributor setup |

## Assignments and changes must follow this ledger

Every ready assignment names decision IDs, donor/pin (or exact pin-selection question),
existing implementation/evidence, one unresolved discriminator if conditional, and the
finished user journey plus attribution output. The lead supplies a reachable base,
owned paths and shared contract. Missing contracts are lead work—not permission for
workers to invent protocols. Successful fit proceeds directly into integration/tests/
notices, not another report-only PR. Preserve useful current PR work and correct
material gaps in place instead of issuing replacement micro-jobs.

Intermediate-capability agents/contributors take specified implementation; advanced
reviewers examine silent-failure boundaries. The lead owns architecture/security,
integration and final acceptance. No vendor/model is required. Concentrate independent
review on consequential changes, not ordinary wording or every repair.

For new ideas, record affected outcome/decision, existing donor, release necessity,
dependencies, owner and test change in this same plan and linked issues. Reopen settled
choices only for failed requirements, license/maintenance risk or demonstrated simpler
fit. Report working journeys, unresolved fit questions and material release blockers;
do not report completion percentages from test or file counts.
