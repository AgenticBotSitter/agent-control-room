# Current completion handoff — first usable task before more polish

2026-09-08 overnight update, source baseline `a834aca`. This updates implementation
status, not the original owner outcomes. Sanitized batches may be pushed only to
the existing private working branch with CI skipped. Public publication, PRs,
merges and Actions dispatch are not part of this overnight authorization. Local
build work is authorized; live database, credentials, providers and deployment
remain separately gated. Preserve unrelated private setup notes outside commits.

## September 8 deployment and product delta

`JOHNNY5_DEPLOYMENT_NEXT_STEPS.md` is the consolidated installation handoff.
`OVERNIGHT_BUILD_2026_09_08.md` records exact local tests, review findings and fixes.
The original overnight deadline remains 12:40:58 UTC, not eight hours from reading
this document. The source changes below do not establish production readiness.

- Protected operator settings and compiled website launcher now support optional
  saved Idea/news keys and a separate two-login Idea-authoring profile. This mounts
  existing save/recap/decision services without task planners, workers or providers.
- Database-only checks verify the selected profile's actual roles and close all
  acquired connections without installing an application. The source inventory
  includes the writer-role SQL when that profile is selected. Neither proves
  backup restoration or actual target readiness until separately run there.
- The deployment-only owner bootstrap now has an explicit protected-input command
  and owned connection cleanup. Its compiled synthetic journey proceeds through
  restricted website login, project creation/read and logout. Real confirmed owner
  identity, input custody and production execution remain separately required.
- The database-check command now also accepts the existing full `agent-tasks`
  envelope and checks configured task/Idea/news/worker roles without starting those
  capabilities. This does not supply the full operator configuration or qualify
  its non-database ports. Actual host connections remain separately authorized.
- A subsequent compiled promotion test exposed a missing fresh-install native Idea
  adapter registration, previously supplied by older fixtures. Authoring now also
  requires that tenant-bound registration at preflight. The separately run setup
  SQL is included in the authoring inventory; it is not an automatic startup write.
- Idea project lifecycle controls use the existing lifecycle service. Project pages
  can link back to their authorized source discussion. News view/sort deep links,
  verified collection-history paging and configured roster selection are connected.
- Needs Me admits the task or recovery owner permission independently, while each
  data endpoint still checks its own permissions. Idea/news skip-link targets exist;
  static rendering is not a live keyboard/browser acceptance result.
- Full sequential Idea/ABS delivery plus the authoring build command passed at
  this baseline. The latter compiled the release and passed 24 checks. No live
  owner login, database change, backup, deployment or provider call occurred.

The shared primary's storage persistence, dedicated provisioning, actual restore,
supervisor/account, real verified owner subject and authorized startup remain
external gates from the operator report. Do not substitute fixtures for them or
change another application's storage without an exact separately approved plan.

## What exists versus what the owner can use

| Outcome | Verified local position | What is still required |
|---|---|---|
| Separate projects | Protected catalog/pages, ordinary and Idea lifecycle, task pages, source-discussion backlinks and explicit browser-tab links | Actual browser/mobile interaction and real persistence |
| Website task to result | Installed pg-boss, protected submission, compiled six-role synthetic journeys, saved artifacts and pending review | Configured owner signing, runtime/host setup and one real task plus revision |
| Productive fleet | Supplied-resource Hermes connector, bounded recovery and node protocol components | Packaged installers, exact host identities/runtime setup, Mac/PC/VPS qualification, continuous multi-job operation |
| Needs Me | Protected saved-task/review list and delivery uncertainty; separate process-local recovery summary | Real fleet trial and usable operational triage; counts alone do not prove recovery |
| Idea Lab | Existing bounded coordinator, synthetic recap/promotion flow, configurable roster and installable non-executing authoring | Live participants/conversation and real end-to-end project work |
| ABS | Attributed Control Center collection/reading logic, private news view, saved source configuration/history and research-task preparation | Configured live feeds and article-to-real-task/result journey |
| Files between machines | Pinned Hermes remote retrieval and filesystem-policy evaluation | Verified run/project association, retained bytes and authorized cross-harness downloads |
| Daily operation | Compiled entries and preparation/rehearsal components | Private PostgreSQL setup/rehearsal, login/ingress, actual process supervision, restore, drain/update/rollback and sustained use |

No total completion percentage is supported. Component test counts must not replace
the real outcomes in this table. The overnight delivery evidence above supersedes
the older E50/E51 verification snapshot for its named suites, not the entire default
test lifecycle or live acceptance.

## The immediate critical path

The September 6 findings below remain historical context where superseded by the
September 8 delta. In particular, the minimal website/authoring operator profile is
now supplied; the full live-task runtime and owner-signing setup are still separate.

**2026-09-06 local source update:** The historical E64 gap below now has asynchronous
completion-store integration and a scoped etcd storage-port adapter in
`src/completion-gate/v1/etcd-checkpoint-store.ts`, built on the bounded exact-key RPC
access. Scripted-transport tests pass; no real independent service is provisioned or
qualified. Trusted binding provisioning, authenticated runtime transport, restore
independence and actual operational acceptance remain open. The adapter cannot initialize
a missing checkpoint. Local project/task browser controls now exist at `/local-preview`,
but interactive acceptance and saved synthetic result/review wiring remain unfinished.

**E64 historical configuration finding:** [Durable checkpoint gap](research/REUSE_E64_DURABLE_CHECKPOINT_GAP.md)
identified a missing implementation, not an operator-supplied password. The asynchronous
adapter and bounded etcd CAS access now exist, as described above; the old test-memory-only
finding is superseded for source implementation, not operational acceptance. Provisioning,
authenticated transport and restore independence remain unqualified. Do not substitute
PostgreSQL self-anchoring or restart the historical LIVE chain.

**Local result integration:** `/local-preview` now mounts the existing native-result
read panel through the owner-cookie adapter, with truthful `not_configured` sources.
It does not yet publish simulated evidence. The proposal/revision rehearsal now saves
both simulated result files with the existing disposable filesystem adapter, reopens
that adapter, and matches each exact byte hash to its persisted review target. Review
checkpoint transport remains scripted. The native receipt/attempt/lease/run/effect
tables remain empty, and the proposal stays proposed. Do not wire simulated output
into `NativeResultStore` or interpret the fixture's review as real owner acceptance.

1. **Browser acceptance:** owner unlocks the Mac. Inspect the existing application and
   use only an already authorized disposable/local setup. Confirm project creation,
   separate tabs, task preparation, assignment and approval review/file intake, including
   refresh and uncertain-response behavior. An unlocked Mac is not native-call authority.
2. **Owner approval integration:** select and implement actual separate owner key custody
   and issuance using existing accepted approval contracts. Keep private keys out of the
   website, worker messages and repository. Pure/source tests can proceed without using
   credentials. Real provisioning and any Keychain operation require a scoped owner step.
3. **Complete executable host setup:** wire reviewed server-only configuration to compiled
   startup, six distinct SQL roles as configured, node enrollment and runtime sources.
   Existing compiled modules and service templates are not an installed service. Follow
   VPS_COMPILED_HANDOFF.md; do not guess secrets, endpoints or host qualification facts.
4. **Real database rehearsal and one real agent task:** after exact setup is inspectable,
   obtain a consolidated bounded authorization for the required environment/calls,
   cleanup and evidence. Earlier one-shot authorizations have been spent. Pass genuine
   task-to-result-to-review/revision before expanding to unattended fleet throughput.
5. **Expand the same working path:** PC/VPS adapters, continuous eligible pickup, Idea Lab,
   ABS and rich artifacts. Build monitoring/restore/update procedures alongside this,
   not after declaring the fleet finished.

Steps 2–3 have meaningful local source/design work remaining while browser access is
unavailable. Do not call the entire program blocked solely because the Mac is locked.
Conversely, do not substitute a series of cosmetic edits for the unresolved critical path.

## Signing distinction that must not be lost

`src/node-bridge/protected-store-signer.ts` implements node-frame signatures using the
node key store. It is not an owner approval issuer. The accepted owner trust contract
requires distinct owner public pins and rejects overlap with current or historical
online server keys. The task UI prepares an unsigned review and accepts separately
signed files; it still cannot produce that owner approval. A login assertion, network
location or transport signature must not be relabeled as permission to execute.

Read CR14C_OWNER_APPROVAL_TRUST_CONTRACT.md and CR14A_INTEGRATION_DIRECTION.md before
choosing the signing integration. Do not ask the owner to upload private keys or assume
that existing Hermes/Codex authentication supplies an approval key. A signing UI must
not imply that every future low-risk scheduled job requires another manual message;
the accepted project policy and bounded effects model must be evaluated explicitly.

## Reuse and execution discipline

The broad candidate search is sufficient. Research further only for a named unresolved
interface, such as owner signing or supported runtime packaging. Keep pg-boss as the
selected queue and native Hermes transport as the preferred file retrieval primitive;
do not reopen wholesale platform selection without an unmet requirement. Every new
custom infrastructure proposal needs a concrete reason existing components cannot fit.
Preserve provenance and download cleanup records. No new download occurred for this handoff.
