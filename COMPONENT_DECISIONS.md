# Component decisions and implementation roadmap

Updated 2026-09-08. **Selected for implementation does not mean implemented.**
This is the public, sanitized summary of the reuse assessment. The published
application remains a pre-alpha contributor preview; no live fleet is certified.
Some later implementation source/tests are still being prepared for public export.
An issue must name an available public base and files before work is assigned.

## What is settled

Prefer maintained components and narrow adapters. Custom infrastructure needs a
specific unmet requirement, strongest-alternative comparison and maintenance cost.
Do not reopen these choices just because their integration is unfinished. Reopen
with a concrete compatibility, security, licensing or measured performance finding.

| Decision | Selected direction | Why / evidence scope | Still to implement or verify |
| --- | --- | --- | --- |
| DR-01 Idea participant planning | Retain the bounded fixed-panel coordinator | Existing loop fits bounded discussions; a dynamic planner is not needed to choose a fixed panel | Real participant execution, recovery and saved project promotion |
| DR-02 News collection/parsing | Retain attributed Control Center collection; rss-parser 3.13.0 and fast-xml-parser 5.11.0 at distinct boundaries | Actual parsing comparisons do not justify another collector or compatibility parser | Full collection-to-reading-to-research integration and source acceptance |
| DR-03 Dependency identity | pnpm 11.19.0 prepared dependency graph | Tested against the actual package layout | Bind exact platform/build inventory to each release |
| DR-04 Original license texts | CycloneDX library 10.2.0 LicenseEvidenceGatherer, build-time only | Actual text collection compared with alternatives; explicit exceptions remain | Complete copied/vendor/assets/external-runtime notices and failure tests |
| DR-05 Token verification | jsonwebtoken 9.0.3 behind the retained synchronous policy boundary | Compared through policy/bootstrap/cache/caller interfaces; avoid an unnecessary async migration | Typed imports, full regression/release checks and real owner login acceptance |
| DR-06 Task authority | Retain canonical task/attempt/result/review records | Notification delivery and agent wake-up do not prove task completion | Connect actual native execution; optional notification routing remains separate |
| DR-07 Article extraction | Readability 0.6.0 + jsdom 26.1.0 | Actual article/HTML comparison favors maintained extraction over custom scoring | Bounded source retrieval/detail storage, fallback and provenance; not a complete reader yet |
| DR-08 Initial workspaces | Native Git detached checkout behind ownership/lease checks | Compared actual checkout behavior with Agent Orchestrator's branch-oriented route | Concrete adapter, contention/dirty-state/restart handling; preserve user files |
| DR-09 Calendar calculation | cron-parser 5.10.0 field expansion/matching; retain schedule policy | 42 selected parity cases after a documented compatibility correction | Typed integration, occurrence-store/replay and upgrade regressions; not queue selection |
| DR-10 Database client | Conditional node-postgres 8.23.0 at existing bounded database interface | Actual values, transaction/queue and release/close comparisons; simple Pool.end alone is insufficient | Late acquisition, bounded close, uncertain commit and real PostgreSQL 17 caller checks |
| DR-11 Formatted results | react-markdown 10.1.0 + remark-gfm 4.0.1 inside retained result panel | 11 checks with actual panel/library code and independent review; less desktop/global-state coupling | Actual parent/auth races, enabled review, accessible browser rendering, bounded resources and protected attachments |

These are dependency targets, not instructions to install every package immediately.
Pin direct/transitive dependencies intentionally and preserve their actual license
texts. Project Apache-2.0 does not relicense imported code. Test-only dependencies
need not ship. Source names/version metadata are not blanket security clearance.

## Useful donor boundaries

- [Control Center](https://github.com/mreflow/control-center): collection/curation
  modules already inform the news workflow; retain attribution, not a second app.
- [Hermes Desktop](https://github.com/fathah/hermes-desktop): selected controlled
  tab/code/diff/media presentation. Do not copy Electron dependencies or shared raw
  session state merely to display a project. Closing a view must not stop work.
- [Hermes WebUI](https://github.com/nesquena/hermes-webui): session/action and stale
  indicator behavior; full shell/global state is not a drop-in React component.
- [Herdr](https://github.com/herdrdev/herdr): observation/terminal candidate, not
  task approval or completion authority. Authenticated adapter comparison remains open.
- [Hermes Studio](https://github.com/EKKOLearnAI/hermes-studio): source-specific
  licensing review required before copying; not treated as permissive UI source.
- Agent Orchestrator and AI Maestro: retain selective workspace/notification ideas;
  neither replaces canonical task/review authority unchanged.

Not every donor is accepted. Some experiments deliberately retained negative
findings. A passing synthetic comparison is not native-host compatibility.

## Open decisions — do not build competing replacements yet

| Area | Candidates / retained baseline | Decisive remaining question |
| --- | --- | --- |
| Durable work engine | Existing pg-boss; DBOS; viable Hatchet integration | Canonical claims, review without blocking other work, restart and uncertain start; choose one engine |
| Native clients and files | Official Hermes interfaces; Codex App Server/SDK; current adapters | Exact thread/turn identity, usage and artifact recovery without repeating work |
| Independent integrity checkpoint | etcd and OpenBao | Actual adapter binding, supported restore and split-commit recovery; one independent anchor, not two business databases |
| Owner signing custody | Existing signing contract and supported platform agents | Exact consent/key binding and host-specific custody; never reuse ambient credentials implicitly |
| Session observation | Herdr plus retained project/result model | Authenticated project/session mapping, disconnect and duplicates |
| Monitoring | Uptime Kuma and complementary Beszel | Real daemon alerts/persistence/restart and representative host metrics, not just helper functions |

PostgreSQL remains the sole transactional authority. Native PostgreSQL logical
backup tools remain the direction for a dedicated database; a real restore test
found that the application fingerprint rejects a differently parenthesized,
equivalent CHECK expression. Fix and review the restore-stable schema contract;
do not disable schema checks or build a custom backup engine. Restored role,
artifact, independent-copy and deployment acceptance still matter.

Codex recovery must distinguish reading retained state, reconnecting/subscribing,
and starting a new turn. Existing qualification resume is not read-only recovery.
Missing usage/identity stays unknown; a disconnect never authorizes blind retry.

## Delivery order and contributor boundaries

1. **Contributor foundation:** reproducible setup/demo, project navigation and
   accessibility; complete notices and public source availability.
2. **First real useful task:** selected database/client/queue adapters, exact
   approval, retained result, review and linked revision on one supported host.
3. **Productive fleet:** continuous eligible pickup, several independent jobs,
   review waiting outside execution capacity, reconnect and per-host packaging.
4. **Idea Lab and news:** bounded multi-bot discussions, saved promotion to a new
   project, article-to-research/guide tasks and protected formatted results.
5. **Daily use:** verified backup/restore, monitoring, graceful updates/rollback,
   browser/mobile acceptance and sustained memory checks.
6. **Optional extensions:** Claude Code, OpenClaw, additional harnesses and generic
   media/content packs after the required Hermes/Codex paths. Contributions welcome;
   no current support or copied-code rights are implied.

See [implementation work packages](IMPLEMENTATION_PACKAGES.md) for exact starting
points. Maintainers retain security contracts, schema changes, integration and
final acceptance. Contributors can implement and test isolated adapters/UI/docs;
independent reviewers should not approve their own changes.

## Publishing and economical collaboration

Actions remains disabled. Use local checks, small local commits if useful, and
batch a coherent outcome into a PR. Git commits/pushes are not themselves Actions
minutes; workflows consume the budget. Do not introduce scheduled polling builds,
automatic deployments or privileged runners. Do not weaken verification merely
to reduce CI use. Claim work through maintainer-confirmed issue assignment, not
by assuming an unacknowledged comment reserves it.
