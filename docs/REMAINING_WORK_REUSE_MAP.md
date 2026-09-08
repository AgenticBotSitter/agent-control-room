# Remaining work and reusable components

2026-09-08; local source baseline `1c21bab`, branch `codex/idea-abs-workflows`.
This is the consolidated planning index, not a new implementation authorization or
claim of production acceptance. Existing contracts and scoped live gates remain.
No total percentage is inferred from the number of rows.

## How to read this

The remaining work is a mixture of missing implementation, connecting existing
components, operator configuration and real-world acceptance. They are different
kinds of work; a new library cannot replace a real login or restore test.

- **Integrated:** present in application source/dependencies with recorded local tests.
- **Evaluated:** pinned source or disposable experiment; not production adoption.
- **Candidate:** suitable for focused comparison; no integration acceptance.
- **Alternative:** competes with the preferred component; do not install both by default.
- **Reference only:** useful product behavior, not approved source reuse.

Multiple projects can supply different parts of one outcome. Multiple queue engines,
credential systems or project databases should not own the same responsibility.
Cost labels below mean relative remaining integration effort (small/medium/large),
not deadlines. Installation, live calls and production changes require their own scope.

## A. First usable private Control Room

| ID / remaining outcome | What already exists | Reuse choice and alternatives | Remaining work and finish test |
| --- | --- | --- | --- |
| A1 Private website and persistent database | Compiled launcher, operator configuration, 64-migration inventory and role preflight | **Retain:** PostgreSQL and existing deployment scripts; use the actual OS/container supervisor, not a new platform | Configuration/operations, medium: verify durable storage without endangering other apps, dedicated database/roles, least-privilege migration and restart persistence. Website-only is not agent-task activation. |
| A2 Login, MFA and owner bootstrap | Access verification and bootstrap command; private setup notes record saved account configuration | **Retain:** Cloudflare Access and current identity provider. **Alternative only if a concrete gap emerges:** Authelia | Configuration/live acceptance, medium: actual authorized owner login, verified subject, deny other users, session expiry/logout and origin protection. Do not replace authentication because a candidate has a login page. |
| A3 Owner execution approval and local key custody | Canonical preparation, paired issuer, review-session controller and attached-terminal command | **Evaluated:** ssh2 1.17.0 signing protocol with disposable keys; **reuse:** dedicated OpenSSH-agent-held key where supported. Platform key stores remain a separate custody option, not assumed compatible | Integration/qualification, large: trusted review-input delivery, distinct owner key, actual consent and signature intake. Login and node authentication do not grant execution. A new signing attempt must not hide an uncertain previous attempt. |
| A4 Completion integrity across rollback | Async checkpoint adapter and bounded etcd record/access code | **Evaluated:** etcd3 client/protocol mapping. **Candidate alternative:** OpenBao KV v2 CAS, especially if independently needed for secrets | Design/operations, large: independent restore domain, exact provisioning, authenticated transport, split-commit recovery and real restart/restore tests. Neither a same-snapshot store nor an ordinary CAS credential proves monotonic integrity. Do not add a bespoke consensus server. |
| A5 Website task to real Hermes result and revision | Task UI, installed queue, compiled task host, one-task Hermes launcher, persistent journal assembly and synthetic result/review journey | **Integrated:** pg-boss 12.30.0. **Retain/integrate:** official Hermes run interface and existing thin connector. Herdr is complementary observation, not a replacement execution authority | Integration/live acceptance, large: supply complete task profile, planner, enrolled runtime, credentials and transport; one authorized task returns real retained output, review and linked revision. Disconnect must not cause another start. |
| A6 Project pages, tabs, archive and reopen | Protected catalog, lifecycle, Idea backlinks and separate browser-tab links | **Retain:** current React pages. **Evaluated presentation candidate:** Hermes Desktop ActiveSessionsBar. **Candidate:** Hermes WebUI project/session grouping | UI acceptance/small-to-medium adaptation: real desktop/mobile create/open/close/reopen, navigation and refresh. Closing a view must not cancel work. Do not replace project IDs with host folder names. |
| A7 Results, review and Needs Me | Saved result/revision/quality services, task/recovery attention and protected downloads | **Retain:** application records. **Candidates:** Hermes Desktop progress cards; Hermes WebUI output/file presentation; pg-boss dashboard for operator queue diagnosis only | Integration/browser acceptance, medium: pending review, blocked/uncertain execution, missing result and revision are actionable. Queue completion or a green terminal badge never substitutes for reviewed task completion. |

## B. Productive multi-machine fleet

| ID / remaining outcome | What already exists | Reuse choice and alternatives | Remaining work and finish test |
| --- | --- | --- | --- |
| B1 Continuous work, concurrency and batch review | Canonical capacity/claims, pg-boss submission/recovery and bounded one-task connector | **Integrated:** pg-boss pickup/concurrency/retry primitives. **Alternatives:** DBOS for durable workflow steps; Hatchet for a broader worker platform | Implementation/qualification, large: continuous eligible pickup and drain around the accepted one-task path. Several jobs progress while earlier results wait for review; uncertain effects are held, unrelated work continues. Do not run three schedulers. |
| B2 Recurrence and unattended bounded policy | Recurrence/occurrence contracts, skill/capability/profile and budget models | **Preferred:** pg-boss timers plus existing policy/occurrence identity. **Alternative:** DBOS only if a measured durable-wait gap justifies migration | Integration, medium/large: timezone/DST, missed runs, pre-claim platform/skill eligibility, concurrency and bounded project policy. Scheduled low-risk work must not require manual message relay for every job; consequential effects retain separate approval. |
| B3 Codex execution on supported hosts | Separate partial adapter and prior macOS qualification evidence | **Prior interface shortlist:** official Codex App Server/local stdio for interactive work; SDK for simpler jobs. Herdr can observe sessions independently | Adapter/qualification, large: refresh official interface and exact installed version before implementation; start/events/usage/targeted cancel/recovery on each supported OS. This inventory does not requalify Codex or infer support from Hermes. |
| B4 Install/enroll Marvin, Ziggy and Johnny5 | One-task entrypoint and persistent journal assembly; historical service templates are explicitly non-installable | **Reuse:** launchd on Mac, systemd where present on Linux. **Candidates:** WinSW versus user-logon Task Scheduler on Windows. Hermes Desktop connection UI can inform onboarding | Packaging/host acceptance, large: runnable versioned packages, distinct credentials, real profile access, upgrade/uninstall, Windows ACLs and process-tree behavior. Never place the one-shot launcher in an automatic restart loop to simulate a fleet worker. |
| B5 Agent/session monitoring and optional interactive terminals | Pinned Herdr v0.9.0 read-only research adapter; no production registration | **Evaluated:** Herdr pane/session API and terminal runtime. **Complement:** Desktop status/tab presentation or WebUI session browsing | Integration, medium for read-only, larger for interaction: authenticated project mapping, offline/stale display and host isolation. Unix owner-only sockets are not a server-enforced read-only role. Terminal interaction needs separate authority; do not build another multiplexer first. |
| B6 Reconnect, cancellation and actual cleanup | Journals, settlement/recovery, HTTPS and bounded native stop components | **Reuse:** supported harness lifecycle and OS process ownership. Herdr reconnect/duplicate-session/restart policies are reference/evaluated pieces, not complete task cleanup | Host qualification/remaining integration, large: terminate the intended run, verify owned descendants, retain late results and distinguish unknown termination. Herdr's disposable cat test does not prove real Hermes/Codex cleanup. |
| B7 Agent-to-agent coordination and coding workspaces | Shared job/attempt/authority model and GitHub worker/jobber process | **Candidates:** AI Maestro messaging/workspace portions; Agent Orchestrator workspace/review-routing modules. Official Hermes rooms are a harness-specific option | Focused source selection, medium/large: pin exact modules and extract only useful transport/presentation. One canonical job owner, isolated checkouts and reviewed outputs. Neither conversational messages nor a second dashboard may claim jobs outside Control Room. |
| B8 Cross-machine files and richer artifacts | Artifact metadata/storage boundaries; native Hermes remote retrieval and path-policy offline evaluations | **Evaluated:** Hermes sandbox artifact retrieval; **candidate route:** authenticated narrow Hermes file API. **Complement:** R2 or approved local storage for retained bytes; Codex requires its own producer path | Integration/live transfer, medium/large: bind file to project/run/attempt, verify size/hash/type/path, save bytes and authorize download. Sandbox-to-gateway retrieval is not automatically bot-to-bot transfer. Do not expose a broad host filesystem browser. |
| B9 Skills, models, capabilities and usage visibility | Worker skill and manifest/profile contracts | **Reuse:** native Hermes skills/runtime capability reporting and selected Codex interface; Desktop/WebUI model/context displays as UI candidates | Integration, medium: show supported OS/tools before claim, refuse mismatches, separate measured usage from estimates and enforce only observable limits. Keep native skill execution native; do not create a competing skill runtime. |

## C. Requested workflows, on the same task system

| ID / remaining outcome | What already exists | Reuse choice and alternatives | Remaining work and finish test |
| --- | --- | --- | --- |
| C1 Multi-bot Idea Lab conversation | Bounded coordinator, roster, authoring, recap/decision and synthetic promotion | **Combine:** official Hermes execution + pg-boss delivery + existing Idea records. **UI candidates:** Hermes WebUI conversation/history and Desktop session presentation. **Reference only:** Hermes Studio room experience | Integration/live acceptance, large: multiple real participants, visible turns, cancellation/time/budget bounds and saved synthesis. Studio is not approved code reuse under the selected public Apache distribution plan. |
| C2 Idea to active ordinary project | Promotion/lifecycle/backlinks, first-experiment draft and up-to-16 project-bound planner templates | **Retain:** existing domain services; **adapt if useful:** Desktop project/tab UI | Configuration/integration, medium: promotion opens its page, authorized project-specific execution resources exist, first task actually completes. Creating a project does not itself provision a runtime/planner. |
| C3 ABS collection and reading | Attributed Control Center discovery, parsing, curation, freshness, history/archive and collection receipts already integrated | **Integrated:** mreflow/control-center modules and fast-xml-parser. **Complement:** pg-boss collection scheduling | Configuration/live/browser acceptance, medium: approved real feeds, readable articles, provenance/freshness, pagination and saved archive choices through repeat collection. No reason to rebuild collection/ranking. |
| C4 Article to research, guide or draft | Verification-first research proposal, ordinary task save and synthetic article-to-reviewed-result journey | **Combine:** Control Center collection + existing task materialization + Hermes/Codex worker + protected results | Integration/live acceptance, medium after A5: selected article produces actual sourced research and review. Unverified articles permit verification-first research; setup/editorial actions must meet their existing gates. No automatic publish or setup execution. |
| C5 Generic content/media projects and additional harnesses | Content/Wayfarer adapters and harness-neutral contracts | **Retain:** generic pieces and native tools. Claude Code/OpenClaw and other connectors remain separately scoped upstream-interface candidates, not accepted integrations | Later module work, large/variable: synthetic public examples, capability-specific real acceptance, separate publishing/media permissions. Preserve private data and historical IDs; do not rebrand by rewriting evidence. Not required to finish the first private task. |

## D. Daily operation and public participation

| ID / remaining outcome | What already exists | Reuse choice and alternatives | Remaining work and finish test |
| --- | --- | --- | --- |
| D1 Backup, restore and retention | Reviewed initial backup/restore procedure and scoped role/inventory checks | **Start with:** native PostgreSQL dump/restore procedure already supplied. **Candidate for ongoing automation:** pgBackRest. **Complement:** R2 only after storage compatibility proof | Operations, medium/large: actually restore into a disposable database, verify rows/ownership/ACLs/restricted login and artifact bytes; prove storage survives container replacement. Existing backup of another app is not sufficient. |
| D2 Host health, uptime and alerts | Application attention and diagnostics; no accepted fleet monitoring deployment | **Complementary candidates:** Uptime Kuma for reachability/alerts; Beszel for host/container resource metrics | Configuration/integration, small/medium: protected health probes, actual outage alert and memory trend. Use one or both only when they cover a need; metrics are not authority for task completion or capacity release. |
| D3 Safe updates and rollback | Compiled releases, maintenance/supervision templates and recovery contracts | **Reuse:** OS supervisors, immutable release directories and native migrations. **Reference:** Herdr compatibility/restart decision code | Operations/qualification, medium/large: canary one node, drain admissions, preserve results/journals, reconnect mixed supported versions and rollback safely. Website tab may reconnect; a single-VPS update can still cause a brief outage. Never promise zero downtime without evidence. |
| D4 End-to-end browser, fleet and load acceptance | Many deterministic/injected suites; memory-safe split PGlite test passed on VPS per operator report | **Retain:** existing test runner and isolated test processes; use existing browser automation for real UI acceptance. Candidate projects' tests supplement, not replace our integration tests | Acceptance, large: mobile/desktop, expired login, dropped responses, real PostgreSQL, multiple agents and sustained bounded load with memory evidence. No new production dependency is needed for this row. |
| D5 Contributor-ready code, licensing and economical releases | Public launch/export preparation, provenance notices and website sources; current local work is ahead of the reviewed deployment pin | **Retain:** GitHub PR/review process and Apache-2.0 project policy; reuse dependency notices and upstream tests | Release/docs, medium and ongoing: reconcile exact public/private revision inventory, safe generic examples, sizable claimable work packets, reproducible local tests and selective batched CI. Do not infer current remote publication status without a separate check. Reading GitHub does not dispatch Actions; pushes/PRs can trigger configured workflows. |

## Candidate register and selection rules

This register links actual upstream projects. Roots were refreshed read-only on
2026-09-08; that is discovery confirmation, not a new pinned audit or proof that
every new upstream feature exists in our installed version. Reuse existing pinned
evidence below; resolve exact files, revision, dependencies and notices before import.

| Component | Intended reuse | Decision and evidence |
| --- | --- | --- |
| [pg-boss](https://github.com/timgit/pg-boss) | Queue, schedules, retries, concurrency; optional operator dashboard | Selected installed 12.30.0, MIT. E01/E02 and later integration evidence. Dashboard is a new unqualified surface with potentially mutating controls, not an owner inbox replacement. Current upstream features do not imply automatic installed-version support. |
| [DBOS](https://github.com/dbos-inc/dbos-transact-ts) / [Hatchet](https://github.com/hatchet-dev/hatchet) | Alternative workflow recovery or full worker engine | Shortlist only. Compare an exact unmet workflow requirement and migration/deletion cost before reopening queue selection. License each selected module/service separately. |
| [Hermes](https://github.com/NousResearch/hermes-agent) | Agent execution, native skills and remote result retrieval | Preferred native runtime; E06–E08 preserve file-transfer scope. No Hermes core fork selected. Refresh installed-host capabilities before activation. |
| [Herdr](https://github.com/herdrdev/herdr) | Local sessions, terminals, discovery/reconnect | Evaluated v0.9.0 at b99002ac99b09e00b4ca692436cb15a6b0d676f1. Apache-2.0 root, dependency/notice closure incomplete. Eight disposable binary checks, five adapter tests and three plugin tests; zero real agent calls. |
| [Control Center](https://github.com/mreflow/control-center) | News discovery, curation, reading | MIT; actual attributed modules integrated at d13e79e866cc33a1fddfe84f563ce2fb9a2113e0. Extend these modules instead of starting a second news engine. |
| [Hermes Desktop](https://github.com/fathah/hermes-desktop) | Small React navigation/progress/onboarding components | E04 pin 3f744975f818bbb40ed029e6b3022cd0c5ad7a24, MIT. Source evaluated, not a wholesale imported Electron app. Project IDs, view-close behavior and browser accessibility need adaptation. |
| [Hermes WebUI](https://github.com/nesquena/hermes-webui) | Conversation, workspace and session UX | MIT root; candidate modules, not React drop-ins. Keep its Python/vanilla-JS runtime and broad filesystem/credential management out of our trusted web process. Pin selected source before reuse. |
| [Hermes Studio license](https://github.com/EKKOLearnAI/hermes-studio/blob/main/LICENSE) | Room workflow reference | Current BSL 1.1 grant is non-commercial; future Apache change date is not current Apache permission. No source adoption selected. Separate permission/review would be needed for conflicting intended uses; do not rely on replace-later licensing. |
| [AI Maestro](https://github.com/23blocks-OS/ai-maestro) / [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | Messaging, isolated coding workspaces and review-routing modules | Focused source candidates. Pin/module-license/test/extraction audit remains; do not import a second control plane to obtain one convenience. |
| [ssh2](https://github.com/mscdex/ssh2) | Established signing-agent protocol | MIT 1.17.0 isolated evaluation, E54–E58. No app dependency or live custody acceptance. Use only selected signer functionality, not general SSH server/client access in the website. |
| [etcd](https://github.com/etcd-io/etcd) / [OpenBao](https://github.com/openbao/openbao) | Independent integrity anchor alternatives | etcd protocol evaluated, source adapter exists; OpenBao source shortlist only. E64/E75 describe the independent placement/restore problem neither solves merely by installing it. |
| [WinSW](https://github.com/winsw/winsw) | Candidate Windows service wrapper | Compare pinned wrapper against user-session scheduling and native runtime constraints. Do not claim installed Windows support. |
| [pgBackRest](https://github.com/pgbackrest/pgbackrest) | Ongoing PostgreSQL backup/restore tooling | Candidate, not provisioned. Start with actual acceptance of the supplied native restore procedure; selected R2 compatibility needs its own proof. |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) / [Beszel](https://github.com/henrygd/beszel) | Uptime versus machine metrics | Complementary service candidates. Reuse services rather than porting monitoring engines into Control Room. |
| [Authelia](https://github.com/authelia/authelia) | Self-hosted identity alternative | Deferred: no named gap currently justifies replacing the chosen Access login. |

## What custom code is still justified

These are narrow application rules, not permission to create whole new engines.

| Application responsibility | Why candidate projects do not replace it | Reuse underneath / deletion rule |
| --- | --- | --- |
| Project/task/attempt/result/review relationships | A terminal session, queue job and discussion have different identities and completion meanings | Existing PostgreSQL domain records; eliminate duplicate projections/stores when they add no independent requirement. |
| Approval and owner-set limits | Login, SSH reachability and an upstream run endpoint cannot attest the exact allowed task/effects | Existing identity/signing libraries and native policy interfaces; custom code only binds canonical scope and validates consent. |
| Cross-harness normalization | Hermes, Codex and terminal observations expose different states and evidence | Thin versioned adapters; reuse native transport/SDKs instead of reimplementing protocols. |
| Ambiguous external effects | Queue retry or session resume cannot prove whether an earlier real action occurred | Upstream status/cancel plus existing journals; custom reconciliation holds uncertainty rather than silently repeating effects. |
| News/Idea-to-ordinary-task linkage | Upstreams do not supply our exact source-evidence/project/approval relationship | Borrow collection and presentation; retain only the small mapping to ordinary tasks. |

For any additional infrastructure, write a one-page exception before implementation:
requirement, up to three candidates, exact failing source/test/license constraint,
why a thin adapter cannot close it, estimated code/operations eliminated, remaining
maintenance and a removal path. Existing code volume or generic security concerns
alone are not a sufficient reason to reject reuse.

## Delivery order: substantial usable batches

1. **First private task:** A1–A5, essential A6/A7 and D1. Reuse the supplied website
   preparation; finish actual custody/runtime configuration and one real result plus
   revision. Resolve checkpoint placement without another custom storage project.
2. **Productive fleet:** B1–B4, B6 and necessary B9, plus basic D2/D3. Qualify one
   continuous supported host, then additional hosts/runtimes. Review waits must not
   stop unrelated jobs. B5 read-only monitoring can proceed alongside this, not delay it.
3. **Idea Lab and ABS:** C1–C4 on the same proven task route; B8 for rich results.
   UI/source work can proceed earlier, but real workflow acceptance depends on A5.
4. **Daily-use acceptance:** complete D1–D4 and sustain the combined fleet/workflows.
   Optional interactive terminals and C5 remain separate from first-task readiness.
5. **Contributor/public upkeep:** D5 alongside all batches, with batched local checks
   and reviewed publication. Keep private configuration and host evidence private.

This list does not change the requested product: Idea Lab and ABS are required owner
outcomes, even though they follow the first working ordinary task. Optional future
consumer packs and additional harnesses are distinguished so the project can finish
a usable release without promising every possible integration.

## Evidence and freshness

Current implementation reconciliation: [completion handoff](CURRENT_COMPLETION_HANDOFF.md),
[deployment next steps](JOHNNY5_DEPLOYMENT_NEXT_STEPS.md),
[overnight evidence](OVERNIGHT_BUILD_2026_09_08.md), and
[Herdr evaluation](research/HERDR_ADAPTER_EVALUATION.md).
Candidate history: [reuse plan](REUSE_FIRST_COMPLETION_PLAN.md),
[validation packet](REUSE_FIRST_VALIDATION_PACKET.md),
[presentation evaluation](research/REUSE_E04_HERMES_PRESENTATION.md),
[checkpoint boundary](research/REUSE_E75_CHECKPOINT_DEPLOYMENT_DECISION.md).

The September 6 roadmap contains superseded branding/publication and implementation
statements; it is used for outcome coverage, not as current deployment evidence.
This pass read current local source/docs and public upstream pages, not private
GitHub PR state or live host configuration. No package/source archive downloads,
installs, test runtime starts, credentials, production changes or Actions occurred.
It records planning recommendations, not new license clearance or new test passes.
