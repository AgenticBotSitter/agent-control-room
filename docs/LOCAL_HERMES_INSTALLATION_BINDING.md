# Local Hermes installation binding

Status: source preparation with disposable test evidence. It does not enable
Hermes or perform an installation. The supported first task remains a bounded
supplied-context text review. Project-writing work is outside this package.

## What this supplies

`src/installer/v1/local-hermes-installation-binding.ts` joins the existing
installer and Hermes records while `agent_readiness` is the active running
installation stage. It recomputes the topology from its complete route input,
then requires exactly the selected local Hermes worker, reviewed source
revision, captured fixed runner settings, successful runner check, protected
qualification observation, recovery proof and healthy service observation.

The output contains only fingerprints, stage/revision, the text-review task
class and the next owner operation. It does not contain commands, private
paths, worker names, provider/model settings, credentials or sessions. It
cannot create a callback, grant execution, start work or pass the setup stage.
Errors have one fixed redacted message.

A saved preparation must be verified against separately supplied current
private inputs. A changed configuration, replaced release, changed route,
revoked or uncertain qualification, failed recovery/readiness, stopped service,
changed service observation or completed/uncertain setup stage refuses. A
mixed local/remote installation can prepare its local Hermes worker while
remote proofs are still pending; this does not prove or admit remote workers.

## Trusted recording contract

These inputs belong exclusively to the protected installation host. The
browser must never supply them. A hash binds an observation; it is not a
signature and does not authenticate its origin.

- The existing sanitized runner report proves one response but contains no
  executable/settings identity. The installer must retain and recheck a
  separate protected qualification observation associating that successful
  report with the exact configuration, worker, release and topology. This
  package does not infer that association from a successful report.
- The `recovery` passed outcome is the verified existing backup/restore
  `proofDigest`. The readiness record must contain that same proof.
- The `platform_service` passed outcome is
  `localPlatformServiceObservationDigestV1(observation)` after the private host
  observes a running, healthy service for the exact release, authority and
  protected-data binding. A proposed service lifecycle is insufficient.
- Supervisor readiness here is bound to the stable topology plan, matching
  existing private operator assembly. Service-lifecycle preparation separately
  binds its own exact active setup-plan revision; one cannot substitute for
  the other by retagging a record.
- `agent_readiness` input is
  `localHermesInstallationStageInputDigestV1(bindings)`. It includes the current
  observation/readiness fingerprints. The preparation returns no successful
  stage outcome. The later owner-authorized binding/first-task check owns that
  outcome and must persist it using the existing plan journal.

## Reuse decision and source composition

Decision: **retain existing Control Room code and build this small installation
connector**. No new scheduler, database, transport framework or session store
is introduced. No third-party source is copied by this package.

The previously accepted source inspections in
[the reuse register](REUSE_CANDIDATE_REGISTER.md) and
[installation reuse map](INSTALLATION_REUSE_IMPLEMENTATION_MAP.md) already
settle the donor question: Hermes WebUI at
`f6a37b2381b2c3f3dc5f1425c2812268b0aa6b2b` is reference-only for conservative
session recovery and bounded refresh; Hermes Desktop at
`2663e2e63fb834c15a30e1e15068277d4339c35d` is reference-only for capability and
connection presentation. Their server/runtime, identities, session stores,
model/provider controls and installers do not implement Control Room's
installation authority. They are not imported. The settled decision is reused
instead of repeating a donor download or adding new license obligations.

| Existing source | Role retained |
| --- | --- |
| `src/harness/hermes-021-v1/subprocess-stream-json-host.ts` | Captures fixed private runner settings; separately creates the bounded CLI process host. |
| `src/harness/hermes-021-v1/runner-qualification-evidence.ts` | Validates the successful sanitized runner check. |
| `src/harness/hermes-021-v1/assigned-task-execution.ts` | Reads canonical task/lease authority, repeats the check immediately before launch, creates ordinary run history and reconciles the retained receipt on restart. |
| `src/harness/hermes-021-v1/local-delivery-composition.ts` | Saves the shared receipt before private execution and preserves uncertainty instead of replaying a process. |
| `src/harness/hermes-021-v1/completed-task-publication.ts` | Joins assigned execution to existing durable result publication. |
| `src/web/v1/hermes-021-local-queue-delivery.ts` | Existing canonical queue-to-local-delivery switch. |
| `src/web/v1/hermes-021-private-installation-composition.ts` | Constructs only the installation-owned delivery callback from fixed subprocess settings and supplied canonical services. |
| `src/web/v1/private-agent-task-operator-configuration.ts` | Existing protected readiness gate and local admission assembly; browser capacity cannot enable Hermes. |
| `src/installer/v1/installation-plan.ts` and `installation-plan-journal.ts` | One ordered setup plan with protected revision persistence. |
| Existing recovery and supervisor readiness validators | Recheck retained proof; no new recovery or service implementation. |

## Remaining composition and real-host boundary

The source-level task → queue → receipt → runner → protected terminal result →
publication → ordinary review/correction path already exists. This package
supplies preparation for binding it to the guided installer; it is not wired
into production startup by itself.

The private host still must capture/recheck the settings observation, obtain
real database/protected-storage/recovery/service evidence, record the precise
stage outcomes, reverify this preparation immediately before owner enablement,
and supply its already established canonical services to
`createPrivateHermes021LocalInstallationDeliveryV1`. Existing operator assembly
and per-task authority checks remain mandatory after that binding. A saved
preparation must never become a long-lived admission token or an automatic
retry instruction.

Only a separately authorized real task through that assembled host can prove
the operational installation. No real task, service, database, credential or
Hermes configuration was accessed by this source package.

## Verification

`tests/local-hermes-installation-binding.test.ts` covers the prepared local
path, mixed topology, exact runner-settings/report binding, failed/revoked/
uncertain proof, stale service and release observations, incomplete readiness,
wrong worker/revision, changed plans and tampered saved preparation. Fixtures
reuse real Control Room backup inventory, restore proof, readiness, topology
and installation-plan validators; they do not run Hermes or a database.
