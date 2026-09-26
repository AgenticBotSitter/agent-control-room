# Package 4: first-start decision needed

The section 8 assignment decisions are merged and the three local worker node records, unspendable public keys, remote-frame refusals, per-project review-profile helper, and Claude queue fence are implemented on `codex/mac-w3-provider-4`. Focused tests and TypeScript checks pass. No live Control Room work was started.

## Fresh install has no project template

`mac:bootstrap-owner` creates the tenant and workspace, but no project. The owner's first project is created through the website. `TaskExecutionPlanner` requires one `template` and explicitly forbids a fallback template or project-ID substitution (`src/web/v1/task-execution-planner.ts:112-119,277-284`). Section 4 says build three templates per active project at provider startup. Thus on a fresh install there are zero legitimate templates, so a full task provider cannot be constructed and the website cannot start in its task-host mode. The owner cannot create the first project through that website. When projects do exist, their creation timestamp is in `control_manual_project_heads.created_at`, not `projects.created_at`; the provider must join these tables.

Please decide one first-start route that preserves the existing single lifecycle. Candidate: run the existing website-only host when there are zero projects; after the owner creates a project, require `mac:down && mac:up` to start the task host. This needs a truthful UI/status and must not silently report workers as operational before the restart. Alternatively provide an approved first-project creation step before provider startup. Do not add a fake project or relax `TaskExecutionPlanner` without a decision.

## Hermes destination cannot yet be read from the selected profile

The `cr` profile has a non-secret `providers.ollama.base_url`, but no `providers.opencode-go.base_url` field. The current owner choice is `opencode-go` / `space-bunny-free`, so the Ollama URL is not its destination. Section 8.D says to ask the owner if the origin cannot be read without a credential and not invent one. `mac:prepare-task-runtime` now requires an approved canonical HTTPS origin; `mac:up` and the owner guide show the required argument. No protected task-runtime file was created.

## Readiness-only fleet telemetry cannot authorize assignment

Section 6 says the host derives fleet signals only from existing pinned-executable readiness and stops if assignment needs anything else. `evaluateFleetEligibility` requires `telemetry.payload.availableStorageBytes.quality === "observed"` even when `requiredScratchBytes` is zero (`src/node-fleet/v1/eligibility.ts`). Executable readiness does not measure available storage, and reporting a made-up observed value would be false evidence. Please approve a bounded, real local storage measurement for the protected artifact/work area, or another explicit resolution; do not change the existing assignment check or pretend readiness is a storage probe.

## Existing-node drift remains a product choice

The node record uses the whole enablement digest as `softwareFingerprint`, and section 8.B requires a differing existing row to be refused. A normal `mac:repin` after any CLI update changes that digest; `seedMacLocalNodeV1` then refuses startup even if only one worker changed. Please decide an owner-attended key/node rotation or whether the node fingerprint should be stable across worker version updates. Do not silently overwrite the row.

The unspendable key's restart proof needs a clear trust-root decision. The current source checks that each database public key and its database fingerprint agree, but cannot compare the random originally generated key against an independent value. Migration 0008's trigger makes an existing key's public material immutable and blocks deletion, so an ordinary update cannot simply swap the key in place; this is an important protection. If section 8.B's “differing existing row is refused” means detecting a restored or pre-seeded *different* valid key as well, a protected Mac-side public fingerprint is needed. If the canonical database and its immutable-key trigger are intentionally the entire trust root, say so and scope the guarantee accordingly. The current source has not been run live and has not received that security review.

## Database role isolation needs a separate security review

The Mac provisioner currently grants `control_room_application` to each of the four local logins (`scripts/mac-local/provision-database.mjs`). `db/roles/production_table_grants.sql` gives that parent role broad SELECT/INSERT/UPDATE rights on all public tables. The dedicated `private_web_roles.sql` and `task_coordinator_roles.sql` files are narrower, but the Mac provisioner does not assign those roles to the four logins. `mac:check-database` checks identity and `SELECT 1`, not denied writes. Therefore its four `ok` lines prove connectivity, not least privilege. This is a source-level finding; I did not inspect or change live grants. Claude should review and decide the required role/grant correction before accepting a real task-host run. No live grant change is implied by this note.
