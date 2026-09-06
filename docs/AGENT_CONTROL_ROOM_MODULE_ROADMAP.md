# Agent Control Room — core and module roadmap

2026-09-06. Local maintainer map against `587cc5b`. Source paths are private planning
references until the exact public tree is reviewed. This is not a publication or a
claim that the listed modules are usable live. Working product name only; organization
brand and license remain undecided.

## Product contract

One shared application with separate project pages, one PostgreSQL authority for work,
and independently registered agent runtimes. Optional modules add workflows to those
same services. They do not create another queue, identity system or database authority.
Modules are source boundaries first, not independently deployed services or arbitrary
plugins. Keep untrusted execution outside the trusted controller process.

## Essential core

| Area | Existing code to retain/review | Remaining proof of usability |
|---|---|---|
| Project workspace | `private-app/`, `src/web/v1/project-service.ts`, shared catalog components | Create, reopen, paginate and archive a real persisted project; separate tabs work on desktop/mobile; permissions enforced after refresh |
| Work lifecycle | `src/web/v1/`, `src/persistence/pg-boss-native-task-submission.ts`, installed queue factories | One admitted task reaches a real agent and returns a result; review and requested revision stay linked; no repeat execution after a lost response |
| Worker connectivity | `src/node-control/`, `src/node-protocol/`, `src/node-bridge/`, `src/harness/` | One supported installed runtime first; reconnect to its existing work, observe accurate state, revoke access and cancel only the intended run |
| Results and attention | `src/node-executor/artifact-storage.ts`, result/review services, Needs Me pages | Retain and retrieve the correct task's files; distinguish missing, stale and unreviewed work; show actionable problems without leaking private details |
| Access and bounded effects | `src/security/`, `src/node-policy/`, owner approval services | Real login/custody configuration, enforced local limits and project policy; no permission inferred from network location or a quality review |
| Reliable operation | `src/web/v1/private-task-host.ts`, `scripts/run-private-vps.mjs`, `src/completion-gate/`, `src/node-service-packaging/` | Reviewed operator setup, real PostgreSQL, shutdown/restart, backup/restore, bounded update/drain/rollback and recoverable uncertainty |

Security, usable result retrieval and honest failure handling are core. A minimum
usable version cannot omit them just to look complete. A disposable contributor demo
can use synthetic resources, but must visibly distinguish them from live operation.

## Optional workflow modules — full scope retained

| Module | Existing starting point | Integration seam | Acceptance scenario |
|---|---|---|---|
| Idea Lab | `src/idea-lab/` | Existing project, participant-task, budget and review records | Bounded discussion by several real agents, inspect synthesis, promote into an ordinary project with its own page and follow-up work |
| News and research | `src/project-adapters/abs-news/`, attributed curation helpers | Article selection creates an ordinary project task; does not run a parallel scheduler | Ingest an authorized feed, inspect an article, request research/setup guide, retrieve the resulting work under its project |
| Content workflows | `src/project-adapters/content-blooms/` | Generic project-pack/capability mapping | Configure a synthetic content project without personal names or account defaults; prepare/review outputs; publication remains a separate authorized effect |
| Specialized media | `src/project-adapters/wayfarer/` | Capability routing plus artifacts/reviews | A separately qualified media route produces a bounded result; missing hardware never appears supported because fixtures exist |
| Additional runtimes | `src/harness/hermes-native-v1/`, `src/harness/codex-v1/` | Shared adapter lifecycle and node protocol | Exact supported version can execute, report usage/state, reconcile interruption and target cancellation; no shared credentials across harnesses |

The first connector is required for a usable core. Additional connectors are optional
installation choices, not a promise that every runtime has already passed qualification.
News/Idea Lab remain part of the owner's intended product even if they ship after the
first core task journey. Disabling an optional module must not break ordinary projects.

## Content generalization, without losing the work

The [targeted generalization map](CONTENT_WORKFLOW_GENERALIZATION.md) identifies an
important distinction: the existing adapter observes an external source's scheduling
and leases. Ordinary Control Room content workflows must use core tasks instead;
do not turn the source adapter into a second scheduler through a cosmetic rename.

The content-specific implementation includes placement, synchronization, routing,
read/control and project-pack code. Review those capabilities individually rather than
deleting the folder. Classify each as generic service, domain-specific optional adapter,
synthetic example or private configuration. Use generic content names in public docs/UI;
keep historical records and original private project identifiers unchanged privately.

Some serialized records and digests contain identifiers. A string replacement is not a
safe data migration and must not rewrite accepted private evidence. Public fixtures
must be intentionally synthetic and validated with their corresponding schemas/tests.
Do not add a backwards-compatibility subsystem merely to preserve personal demo branding.

## Delivery order and real dependencies

1. **Contributor preview:** review/export policy, exact file/notice inventory, clean
   source/build/test setup, generic demo and public contribution guidance. This can
   precede production credentials and live deployment, but not honest status labeling.
2. **First usable private core:** finish owner configuration/custody and independent
   checkpoint placement; rehearse real PostgreSQL; perform one scoped real task through
   result, review and revision. Public contributor UI/docs work can run alongside it.
3. **Continuous work and fleet:** package the supported connector for additional hosts;
   prove several eligible tasks can progress while other results await review. Test
   disconnects, stale claims, cancellation and access revocation before unattended use.
4. **Workflow modules:** expand Idea Lab, news/research and generic content flows on the
   same proven task path. Parallel UI work is possible earlier; live claims depend on core.
5. **Daily-use beta:** demonstrate sustained operation, phone/desktop use, restore and
   rolling-update behavior. Publish a supported-version matrix based on observed evidence.

No deadline or percentage is inferred from existing file counts. The exit scenarios
above, not the number of documents or unit tests, determine readiness.

## Review ownership

The owner is initially the accountable maintainer. Assistant-generated reviews and
automated tests support that decision but do not impersonate another GitHub reviewer.
Community maintainers may own UI/docs or adapter areas after establishing trust.
Architecture, permissions, migrations and live qualification remain lead-owned until
explicit responsibility is delegated. Independent review is required where the risk
warrants it, not as a ceremony for every wording change.

Every ready issue needs an exact public base, non-overlapping scope, prerequisites and
completion evidence. The four initial community drafts are an entry queue, not the
whole roadmap. Changes merge only after review and integration checks; deployment is
separate. Unverified community code never runs with the owner's credentials.

## Immediate remaining preparation

Finish exact candidate content/privacy review and dependency/asset license provenance;
define the successor runnable-source distribution policy without weakening historical
contracts; prepare the isolated contributor setup. Brand, licensing and publication
decisions remain owner choices. No public repository or account change occurred here.
