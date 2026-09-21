# Installation reuse implementation map

**Status:** accepted implementation map for the supported single-machine
installer. It records what to reuse before new installation code is written.
It does not authorize an install, download, database change, service start,
credential access or worker run.

## Decision summary

The missing product is an installer and installation coordinator, not another
Control Room runtime. Most authority, storage, queue, recovery and agent
adapter pieces already exist in this repository.

The one external project that can remove substantial installation work is T3
Code, narrowly adapted under its MIT license. Its versioned release staging,
checksum, atomic-install and service-update ordering fit the missing delivery
mechanics. Its server runtime, connection authority, profiles and provider
control do not fit and will not be imported.

Any source copied or materially adapted from T3 must retain its MIT notice in
`third_party/` and be recorded in `THIRD_PARTY.md` before the package can be
accepted.

## Gap-by-gap decisions

| Missing part | Reuse decision | Exact source or retained component | Thin Control Room work that remains |
| --- | --- | --- | --- |
| Versioned release download and install | **Adapt** T3 Code, MIT, pinned at `6a699f0f2fbd8847d7ec2df8d9245ce8c2eb8707` | T3 `scripts/install.sh`, `scripts/install.ps1`, `scripts/install.test.ts`, `scripts/release-smoke.ts`; concepts only from `scripts/build-npm-platform-packages.ts` | Produce the Control Room archive/manifest, verify checksums, stage into a version directory, smoke-test, write an install-complete marker and switch the stable/current pointer atomically. |
| Release build and license evidence | **Retain** Control Room | `scripts/build-vps.mjs`, `scripts/runtime-license-*`, `src/release-candidate-precheck/v1/*` | Assemble the already-built server/browser plus migrations, launcher, license inventory and platform metadata into a reproducible archive. |
| Guided setup | **Retain** Control Room React and protected setup contracts; use donors as behavior references only | `private-app/app/installation-topology*.tsx`; `src/harness/v1/installation-{guidance,setup-view,setup-wire,readiness}.ts`; T3 install/status interaction; Hermes Desktop `src/main/{connection-status,installer-download,installer}.ts`; Hermes WebUI `api/{onboarding,updates}.py` | Build one resumable installation plan that invokes explicit installation-owned actions and returns only sanitized evidence. Do not import Electron, Python, donor identities, provider settings or secret stores. |
| PostgreSQL roles and migrations | **Retain** Control Room | `deploy/postgres/{provision-database.sql,apply-migrations.mjs,evidence.mjs,migration-ledger.json}`, `db/roles/*`, `src/web/v1/private-postgres.ts` | Wrap the existing guarded operations in the installation plan; do not create a second database setup path. |
| Protected local results | **Retain** Control Room | `src/artifacts/v1/{persistent-local-storage,artifact-backup-inventory}.ts`, `src/web/v1/private-artifact-storage.ts`, `src/harness/v1/local-backup-restore-readiness.ts` | Create/select an owner-private root, run the existing preflight and bind the evidence to this installation. |
| Background service lifecycle | **Adapt narrowly** from T3, same MIT pin | T3 `apps/server/src/cloud/bootService.ts`, `bootService.test.ts`; Control Room `src/harness/v1/{macos-local-service-package,macos-local-service-preflight,local-supervisor-readiness}.ts`; `scripts/worker-inbox-platform/lib/artifacts.mjs` | Keep pure platform renderers and tested ordering: stop before replacement, start last, bounded drain, restart old verified release after failed update, status and data-preserving uninstall. Do not import T3 Effect services, environment/profile stores or server launcher. |
| Backup and restore | **Retain** Control Room and operator-installed Restic 0.19.1, BSD-2-Clause | `deploy/postgres/{backup-database,restore-database,restore-identity,evidence}.mjs`, `scripts/backup/restic-retained-snapshot.ts`, `src/artifacts/v1/artifact-backup-inventory.ts` | Join existing database and protected-file evidence into one setup stage and require a disposable restore. Restic remains external unless a later bundle decision adds its binary, checksum and notice. |
| Upgrade and rollback | **Adapt** T3 staging/service ordering; retain Control Room fencing | T3 installer paths above plus `apps/server/src/cli/update.ts`; Control Room `src/harness/v1/{installation-transition,installation-transition-store,database-relocation-preparation}.ts`, `src/security/rollback-checkpoint.ts` | Switch only between verified releases. A database rollback uses a bound restore and one fenced writer; never synchronization or two active authorities. |
| Hermes Agent | **Retain** Control Room; donors remain test references | `src/harness/hermes-021-v1/*`, `src/web/v1/{hermes-021-local-executor,hermes-021-local-queue-delivery,hermes-021-private-installation-composition}.ts`; Hermes WebUI session event/recovery files | Supply the private installation binding, protected data/restart proof and later a separately qualified bounded writing policy. Do not add another Hermes framework. |
| Claude Code | **Retain** Control Room; official SDK is a test reference | `src/harness/claude-code-v1/*`, `src/web/v1/{claude-code-local-executor,claude-code-local-queue-delivery}.ts`; Anthropic SDK MIT pin `f7547d7233527739ece8b12ed28c57be96c966b5`, `src/claude_agent_sdk/_internal/{query.py,transport/subprocess_cli.py}`, `tests/{test_close_cancellation.py,test_transport.py}` | Qualify the installed CLI input, authentication, cancellation and reap behavior, then add the smallest process host beneath the existing owned session. |
| Codex | **Retain** Control Room; T3 is reference only | `src/harness/codex-v1/*`, `src/node-bridge/codex-native-process.ts`; T3 `packages/effect-codex-app-server/src/_internal/stdio.ts` | Add Mac executable and private-state custody beneath the existing App Server contract. Do not adopt T3's Effect runtime or session authority. |
| Optional observation/review/containment | **Defer or keep optional** | Herdr Apache-2.0 pin `309749ad65f3aa596f077ec23a1bf3ee428b7a04`; Ralph Sandbox MIT pin `5cc70ef4d09e336e6d9c5cedd91a87270eeb51b6`; Alibaba Open Code Review Apache-2.0 pin `71ed3a288df6435f240b7194f19041b4fcc4ab7d` | Herdr may observe only; Ralph may inform a later isolated coding executor; Open Code Review may add advisory review. None becomes installer authority, scheduler, task runner or approver. |

## Implementation order

1. Build a reproducible release archive, manifest, checksum and license
   inventory using the adapted T3 staging/version layout.
2. Build one resumable setup plan: preflight, private roots, PostgreSQL,
   first owner, background service and health evidence. A failed stage remains
   failed or uncertain; it never becomes success because the page reloaded.
3. Add service status, stop, restart, update and data-preserving uninstall
   using the reviewed platform ordering.
4. Rehearse backup/restore, service restart, upgrade and rollback across two
   verified local release directories.
5. Activate the existing Hermes vertical slice first, then Claude, then Codex.
6. Install from the exact release asset a public user downloads, not from a
   developer checkout.
7. Add remote worker enrollment and controlled two-computer proof while
   retaining the same installer, authority and task lifecycle.

## Rule for future packages

Before any substantial installer or runtime package starts, its work packet
must name the matching row above. If the row says adapt, the package identifies
the pinned donor files, removed custom work, retained notice and disposable
fit test. If it says retain, the package extends the named Control Room
component instead of inventing a parallel implementation. A new donor requires
the full [reuse-before-custom gate](REUSE_DECISION_GATE.md) before code work.
