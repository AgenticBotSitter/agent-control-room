# Component decisions and implementation roadmap

Current integration order, outcome coverage, remaining bounded evaluations and
assignment requirements live in [PUBLIC_BUILD_PLAN.md](PUBLIC_BUILD_PLAN.md).
The historical decision evidence below does not imply current main contains every
component-branch implementation. Public CI is now enabled; older disabled-CI wording
below is superseded by docs/ci-budget-security-review.md.

Updated 2026-09-09. **Selected for implementation does not mean implemented.**
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
| DR-01 Idea participant planning | Retain the bounded fixed-panel coordinator | Existing loop fits bounded discussions; saved two-round discussion, owner-only promotion and replay pass a disposable integration test | Real participant execution, process-crash recovery and live saved-project acceptance |
| DR-02 News collection/parsing | Retain attributed Control Center collection; rss-parser 3.13.0 and fast-xml-parser 5.11.0 at distinct boundaries | Actual parsing comparisons do not justify another collector or compatibility parser | Full collection-to-reading-to-research integration and source acceptance |
| DR-03 Dependency identity | pnpm 11.19.0 prepared dependency graph | Tested against the actual package layout | Bind exact platform/build inventory to each release |
| DR-04 Original license texts | CycloneDX library 10.2.0 LicenseEvidenceGatherer, build-time only | Actual text collection compared with alternatives; explicit exceptions remain | Complete copied/vendor/assets/external-runtime notices and failure tests |
| DR-05 Token verification | jsonwebtoken 9.0.3 behind the retained synchronous policy boundary | Integrated with strict retained claim/time policy; focused and compiled regressions passed | Real owner login and release acceptance remain open |
| DR-06 Task authority | Retain canonical task/attempt/result/review records | Notification delivery and agent wake-up do not prove task completion | Connect actual native execution; optional notification routing remains separate |
| DR-07 Article extraction | Readability 0.6.0 + jsdom 26.1.0 | Bounded extraction worker, approved collection/detail storage and protected reader integrated; synthetic/native PostgreSQL evidence | Physical browser acceptance, qualified live sources and host resource policy remain open |
| DR-08 Initial workspaces | Native Git detached checkout behind ownership/lease checks | Concrete port, durable intent/creation/removal journal, physical root binding and read-only observation; native preservation and forced-process tests | In-flight Git mutation recovery, safe re-adoption, retention and runtime integration remain open |
| DR-09 Calendar calculation | cron-parser 5.10.0 field expansion/matching; Luxon 3.7.2 ambiguity resolution; retain schedule policy | 42 frozen parity cases; 52 calendar tests; native concurrency/replay; independent remediation review accepted | Automatic dispatch/recovery is still unfinished; run frozen regressions on upgrades; not queue selection |
| DR-10 Database client | node-postgres 8.23.0 at existing bounded database interface | Integrated bounded pool/client lifecycle; real PostgreSQL 17 transaction, queue, role and backend-termination checks passed | Production configuration, broader worker recovery and release acceptance remain open |
| DR-11 Formatted results | react-markdown 10.1.0 + remark-gfm 4.0.1 inside retained result panel | Integrated protected renderer with size fallback, inert HTML/images, safe links and stale-parent refusal; source review and regressions passed | Accessible physical browser acceptance, protected attachments and full workflow acceptance remain open |
| DR-12 Optional session observations | Operator-managed Herdr v0.9.0 pane-list interface; retain CR project/result authority | Multi-source project projection, retained-state revocation, protected API/UI and bounded collector implemented and reviewed; 15 synthetic tests. Earlier disposable binary evaluation remains separate | Bind approved executable/endpoint identity, wire and qualify native port, host isolation, physical browser and deployed collection; no generic socket proxy or inferred execution authority |
| DR-13 Work engine | Conditionally retain pg-boss 12.30.0 and existing CR adapters | Both pg-boss and DBOS pass the short review-phase comparison; no required replacement benefit demonstrated. Restored submission/worker/runtime plus readiness/cancellation regression suite: 55 tests pass with fake I/O and disposable PGlite | Integrated canonical admission/replay, uncertain native start, process crash, real drain, occurrence and PG17-role gates; these tests do not close live recovery acceptance |
| DR-14 Monitoring | Conditional Kuma reachability/alerts; optional Beszel host metrics | Kuma condition/database tests and inspected interfaces; Beszel source evidence only | Daemon/notification/restart and actual host metrics tests, protected readiness, release/notices; Beszel disabled until accepted and useful |
| DR-15 Integrity checkpoint | Conditional retention of existing etcd adapter | Actual CR/service binding; OpenBao remains viable with narrower deletion permissions but a different identity/CAS mapping | Independent placement/pins, authenticated transport, supported restore and split-commit recovery; etcd credential can delete, missing head must fail closed |
| DR-16 Owner signing | Conditional dedicated owner-controlled agent using ssh2 protocol and retained bounded issuer/review | Owned connection/cancellation, pinned-protocol evaluation and paired canonical issuance tested locally; no real custody proven | Dedicated key/pins, trusted exact consent, actual socket/cleanup and platform qualification; no ambient agent or forwarded owner key |
| DR-17 Native connectors/files | Conditional Hermes structured APIs and Codex App Server through bounded TS transport; separate attachment admission | Exact-ID Codex projection, one-shot JSONL and owned read lifecycle implemented; 11 effect-free tests. Python SDK remains viable | Durable Codex-specific identity/current admission, native transport qualification, canonical reconciliation, event/usage gaps, export containment and full lifecycle; no blind resume/new turn. See CODEX_READ_RECOVERY.md |

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

## Conditional choices and unfinished validation

All 17 integration directions are now recorded above. This is not completion of
the exhaustive comparison or implementation: several choices are conditional.
Their outstanding comparative and acceptance tests remain in the final column.
Reopen a direction on failed requirements or demonstrated replacement benefit;
do not install competing stacks merely because those tests are unfinished.

PostgreSQL remains the sole transactional authority. Native PostgreSQL logical
backup tools remain the direction for a dedicated database. The restore-stable
CHECK expression fix now passes two successive native PostgreSQL 17 dump/restore
cycles, exact schema/ownership/ACL checks and negative tamper cases. Schema checks
were not disabled; see POSTGRES_RESTORE_EVIDENCE.md. Full production artifact
pairing, independent copies and deployment acceptance remain unfinished.

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

Public CI is enabled for pull requests and `main`; standard public GitHub-hosted
runners do not consume the private repository's exhausted Actions allowance. Batch a
coherent outcome into a PR and avoid scheduled polling builds, automatic deployments
or privileged runners. Do not weaken verification merely to reduce CI use. Claim work
through maintainer-confirmed issue assignment, not by assuming an unacknowledged
comment reserves it.
