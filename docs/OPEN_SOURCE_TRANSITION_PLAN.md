# Control Room — public community build transition

Date: 2026-09-06. Local proposal following the owner's request to prepare an earlier
public community build. Not a publication, licensing grant or production authorization.

## Decision in plain English

### Owner clarification: product, umbrella brand and contribution structure

The owner's preferred working product name is now **Agent Control Room**, emphasizing
multiple agent runtimes rather than a generic dashboard. The website/organization brand
is still undecided; do not infer a spelling or domain from dictated names. Personal
founder attribution and a modest website link are welcome. Do not create an organization,
rename packages, reserve a handle or publish a license based on this working preference.

Recommended account structure: the existing personal GitHub account owns a new Free
organization under the chosen umbrella brand. That organization owns a proposed
`agent-control-room` public repository. The private repository stays where it is;
organization membership neither moves it nor shares it with public contributors.
Personal paid subscriptions and organization plans are distinct. The reported $48
payment does not establish plan, billing interval, product or remaining allowance;
check the account's Billing & Licensing page before changing any subscription.

The public profile/README can say “Created by [approved founder name], a project from
[approved website brand]” and link to guides/news, with an About/contact section.
No required website login, marketing signup, tracking or private-dashboard links should
be introduced as a condition of using or contributing to the application.

Remove Content Blooms branding and personal project identity from the public experience,
but preserve reusable capabilities as generic content workflows. Keep the original
private configuration, records and history intact. This is not permission to publish
renamed private data. Other personal demo brands follow the same rule.

| Shared product layer | Initial responsibility |
|---|---|
| Essential core | Login and permissions; projects/pages; tasks and eligible pickup; worker registration/capabilities; bounded execution; progress, artifacts, review/revision; offline/uncertain state handling |
| First connector | One proven end-to-end agent runtime, then additional Hermes/Codex routes through the same interface |
| Optional workflow modules | Idea Lab, news-to-research, generic content production, specialized media workflows and extra integrations |
| Operator capabilities | Backups, restore, secure installation and update/drain/recovery, required for reliable use even if hidden from everyday project UI |

“Core first” changes delivery order, not the full promised scope. Security and recovery
are not optional paid add-ons. Start with modules in one repository and one application,
not a marketplace, arbitrary in-process plugins or a separate service for every feature.
Optional features must use the same project/task/review contracts and must not introduce
their own global scheduler, database authority or permission bypass.

Contribution validation proposal: issue acceptance criteria first; contributor branch
and PR; automatic build/tests on disposable hosted runners without private secrets;
review by an accountable maintainer other than the author; additional independent
technical review for security/data/connector changes; integration tests; maintainer
merge; and separately authorized private canary deployment. Contributors retain
responsibility for AI-assisted code. Automated checks and assistant analysis are
evidence, not a substitute for accountable GitHub reviewers or proof of live behavior.
Initially the owner is the accountable maintainer, assisted by this development process;
trusted community maintainers can take defined areas over time. Do not claim reviewers
have been recruited or that multiple instances of one account provide independent
GitHub approvals. Small UI/docs PRs need proportionate review, not production ceremonies.

GitHub Free supports protected public branches. Configure required checks and PR review,
block force pushes/direct contributions to the protected branch, and apply appropriate
code ownership when maintainers exist. Decide emergency bypass policy explicitly rather
than promising settings that have not been configured. No such settings changed here.

Sources checked: [organizations](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/about-organizations),
[plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans),
[protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
[billing overview](https://docs.github.com/en/billing/how-tos/products/estimate-spending).

Keep the private project and its history intact. Prepare a separate, reviewed public
source tree under a new GitHub organization. Make that public tree the home of shared
product development after cutover; keep personal projects, deployment configuration,
credentials and operational records private. Do not maintain two permanent competing
copies of the application. Community participation is welcome, not guaranteed capacity.

The product remains a project-neutral control room: separate project pages; tasks,
worker capabilities, automatic eligible pickup, progress, files, review and revisions;
bounded multi-agent Idea Lab discussions promoted to projects; optional news-to-task
workflows; private self-hosting and reliable reconnect/update/recovery.

## Verified starting point

- Local source is committed through `9f7d4cf`; the interrupted launcher follow-up made
  no source edits. The unrelated untracked poster is not part of this transition.
- BUILD_STATUS E83 records 48 compiled/launcher checks. E82 records the latest full
  suite: 3,126 pass and two platform skips. These are not live fleet acceptance.
- The architecture is already project-neutral, but branded fixtures and UI still
  occur in `src/fixtures/data.ts`, `src/simulator/`, `app/control-room-dashboard.tsx`,
  `app/components/wayfarer-workspace.tsx` and project-specific adapters. This is an
  initial targeted inventory, not a complete privacy or dependency audit.
- Existing public packages are a restricted contract/observation candidate, not the
  runnable application. Their license files contain only `Apache-2.0`, not the full
  text; candidate manifests lack license declarations. This does not establish a grant.
- CR10Q-SEC-025 accepted an earlier effect-free snapshot with release blockers retained.
  It does not approve today's application for publication.

## GitHub ownership and connection

Use a GitHub Free organization with a brand chosen by the owner, and a proposed
`agent-control-room` repository. An organization is a shared project identity managed through
personal accounts, not another shared login. The existing personal account can own it;
that does not automatically expose the personal account's private repositories. Brand,
organization handle, public maintainer identity and account linkage still need approval.
Do not promise anonymity: public commits and organization/profile settings can link identities.

Do not change the private repository's visibility, transfer its history, or attempt a
public fork of it. Start with a reviewed export and fresh public history, retaining
upstream copyright, licenses and necessary attribution. Keep export path/hash provenance
privately; publish only reviewed attribution, not private commit identities or locators.

After cutover, public pull requests modify shared application code. The private
installation consumes a reviewed, pinned public version; private configuration and
project packs remain separate. Private-origin generic fixes are submitted through a
clean public checkout after review, never through automatic branch mirroring. Do not
add a public push remote to the private checkout as the publishing mechanism.

GitHub currently provides free standard hosted runner usage for public repositories.
This is not a promise that larger runners, storage, packages or all services are free.
Moving a workflow caller does not erase private-workflow billing. Public CI must test
the actual public project, not act as a relay for private workloads. Existing no-push/
no-Actions directions remain in force until the exact public setup is authorized.

## What belongs where

| Public shared project, after review | Private installation and archive |
|---|---|
| Generic web app, domain services, database migrations and queue integration | Actual project/customer records and business workflows |
| Harness interfaces and approved Hermes/Codex connector source | Agent profiles, credentials, node enrollments and trust material |
| Generic project-pack interface and synthetic examples | Personal project packs and proprietary integrations |
| Generic Idea Lab and news/research workflow features | Real conversations, feeds requiring credentials, article/task history |
| Tests with synthetic identities and disposable resources | Production evidence, private reports, backups and artifacts |
| Documented setup requirements and placeholder configuration | Actual domains, addresses, usernames, TLS and deployment configuration |
| License notices, contribution guide and public roadmap | Internal review history and private security findings |

Source code implementing authentication/security is not inherently secret. Separate
its implementation from actual keys, identities and confidential incident information.
Do not publish private business data just because a string was renamed. Generalization
means removing runtime dependencies on personal examples and using genuinely synthetic
fixtures, not mechanically replacing names throughout historical documents.

Retain the modular monolith and one PostgreSQL business-state authority. Hostinger is
our installation choice, not a requirement for every adopter. PGlite remains for tests/
development. Keep existing adapters and thin configuration seams; do not introduce a
microservice split, new plugin framework or alternate scheduler to accomplish publishing.

## Delivery phases and completion evidence

| Phase | Work | Evidence needed to finish |
|---|---|---|
| P0 — Preserve and map | Record private baseline; inventory source, dependencies, assets, docs and private coupling | Reviewed per-path inclusion/exclusion list and retained private baseline |
| P1 — Public project brief | Draft vision, honest status, architecture map, roadmap, contribution/security guidance and reuse decisions | Documents useful without private links; owner selects brand, license and public contact |
| P2 — Generalize and extract | Replace personal demo dependencies with synthetic examples; assemble approved app plus its build/test dependency closure in a separate local tree | No private checkout dependency; source/secret/license/asset/manual privacy review of exact bytes |
| P3 — Contributor rehearsal | Install/build/test and run the documented disposable demo from the isolated candidate | New contributor can reproduce the demo without our accounts, machines, secrets or paid provider call |
| P4 — Publish development preview | Create organization/repo only after exact owner approval; upload reviewed tree with fresh history; configure protected main and safe CI | Reviewed public files/settings; no private history/logs/artifacts; clearly labeled pre-alpha, not production-ready |
| P5 — Community build | Open independently workable issues; review public PRs; finish one real private task journey in parallel | Shared improvements tested and merged; private installation pins accepted version |
| P6 — Working beta | Expand fleet, Idea Lab/news, install/update/restore and sustained-use testing | Actual task/result/revision and recovery evidence, then an explicitly reviewed beta release |

P1 can support a docs-only community announcement before P2/P3 finish, but it must say
that runnable source is not yet available. Do not advertise an SDK-only export as the
whole Control Room. The desired first code preview is a runnable contributor demo,
with incomplete live features labeled and no ready-for-production claim.

The old CR10 public-package policy explicitly excludes executable effects and admits
only eight narrow roots. A public runnable application exceeds it. Before exporting
application code, document and review a successor source-distribution policy; preserve
historical contracts and evidence, and do not silently weaken their checks. Distinguish
publishing reviewed pre-alpha source from signing/certifying a production distribution.
Do not create another release engine merely to host development source on GitHub.

The [developer-preview policy draft](PUBLIC_DEVELOPER_PREVIEW_POLICY_DRAFT.md) now
defines that separate proposed scope and its exact-source review/rehearsal checklist.
It is not accepted export authority and does not modify the old SDK contract.

## Community work lanes

The [contributor guide draft](PUBLIC_CONTRIBUTOR_GUIDE_DRAFT.md) translates the workflow
below into contributor-facing instructions. It has no private queue dependency, permits
multiple independent PRs and includes blocked-work handoff. Publication prerequisites
remain explicit; no issue or contribution channel has been opened.

Keep us responsible for architecture, security boundaries, integration and final review.
Use GitHub issues and PRs for community work; contributors need not install Control Room
or obtain access to our existing private serialized worker queue just to contribute.
Do not build a new contribution scheduler.

| Lane | Useful first contributions | Shared boundary / done test |
|---|---|---|
| Project experience | Generic project navigation, accessible task/review/file views | Existing app services; synthetic project-to-task browser flow |
| Setup and documentation | Linux/Mac/Windows instructions and disposable demo troubleshooting | Fresh-checkout reproduction; precise platform support claims |
| Harness adapters | Supported runtime capability/version checks and connector packaging | Existing job/session protocol; offline tests followed by separately approved native evidence |
| News/research | Generic feed configuration, curation and article-to-task UX | Existing project/task services; licensed fixtures and attribution |
| Idea Lab | Participant configuration, bounded discussion UI and project promotion | Existing coordinator and project model; synthetic rounds and promotion |
| Reliability/testing | Disconnect, lost-response, restart and update regression cases | Preserve uncertain outcomes; no duplicate external task execution |
| Reuse/dependencies | Proven alternatives, complete notices and dependency provenance | Named gap, version/license evidence, integration cost and acceptance scenarios |

Each issue names outcome, OS/runtime prerequisites, dependencies, source boundaries,
acceptance commands and upstream/licensing constraints before someone claims it.
Maintainers mark assignments to avoid overlap. Contributors may submit several
independent PRs and take another ready issue while review is pending; dependent work
must declare its base. Reasonable retries are allowed; preserve useful failure evidence,
mark blocked work with a reproducible explanation and release assignment when needed.
No self-merge or automatic authority from agent-generated output. Start with a small
ready queue; keep the complete roadmap visible without opening hundreds of vague issues.

## License and public contribution safety

Recommend Apache-2.0 for owner-authorized original code as a candidate, not a decision
already made. Confirm ownership/rights and choose a license before accepting code under
it. Existing third-party licenses/notices remain attached; audit copied code, transitive
dependencies, fonts, images and generated assets. Private use does not justify postponing
license compliance. Unknown or incompatible material stays out until resolved.

Decide a simple contributor sign-off policy and publish it before contributions begin.
Do not imply that a sign-off alone proves ownership or permits relicensing third-party code.
Provide a real private vulnerability-reporting route before inviting security reports;
do not direct users to post credentials or vulnerabilities in ordinary issues.

Public PR CI: disposable standard hosted runners, no private credentials or private
repository checkout, read-only token by default, pinned actions, explicit time/concurrency/
retention bounds, and review for workflow changes. Do not run untrusted PRs on the Mac,
PC or VPS; do not execute their code in privileged `pull_request_target` workflows.
Keep deployments and production secrets entirely out of initial community CI.

## Immediate next batch and owner decisions

Next local batch: produce the per-path export inventory and public project-brief drafts;
resolve the runnable dependency closure and license/asset list before copying source.
Continue generic integration work against the preserved private baseline until cutover.
No downloads, public repository, workflow or service were created by this plan.

Before public creation, confirm the exact brand/organization handle (the spoken website
name is not treated as a verified domain), project name, license/rights, public maintainer
identity/contact, and whether the first announcement is docs-only or the runnable preview.
These choices do not block local inventory and drafting. Public contributions may reduce
the workload over time; recruitment and review also cost time and cannot guarantee a
weekend completion or replace the remaining live acceptance work.

## Official sources checked 2026-09-06

- [Organizations and personal account ownership](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/about-organizations)
- [Actions billing and workflow caller attribution](https://docs.github.com/en/actions/concepts/billing-and-usage)
- [Visibility changes expose code and Actions history](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)
- [Fork permissions and visibility](https://docs.github.com/en/pull-requests/reference/forks)
- [Safe public workflow execution](https://docs.github.com/en/actions/reference/security/secure-use)
- [Apache-2.0 terms and conditions](https://choosealicense.com/licenses/apache-2.0/)
- [Starting an open-source project](https://opensource.guide/starting-a-project/)
