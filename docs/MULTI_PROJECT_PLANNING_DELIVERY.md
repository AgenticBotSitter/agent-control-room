# Multiple explicitly configured projects

2026-09-08. Local source integration; not runtime provisioning or live acceptance.

## What changed

The existing coordinator can plan work for 1–16 explicitly configured projects in
one installation. `coordinator.planning.template` remains the primary template for
backward compatibility. Optional `coordinator.planning.additionalTemplates` contains
up to 15 complete additional `NativeTaskTemplate` records. Each has a unique template
ID and exact project binding; ambiguous lists, invalid authority digests and unsupported
native effects reject before database acquisition. No wildcard or fallback is accepted.

Startup and result-coordinator reconstruction capture the complete configuration.
The existing planner selects by exact project ID after current owner/project/source
authorization. Planning and revision retain their template digest, project-specific
acceptance-profile checks and expiry checks after locks and at commit. Saved plans,
results and historical receipts remain readable without the current project template.
The protected preparation view reports unconfigured projects as `not_configured`.
Its optional configuration lookup runs only after database-backed authorization.

This is small application-specific selection glue, not custom replacement infrastructure:
the existing planner, assignment coordinator, queue, pools, HTTP operations, quality
services and approval contracts are reused. There is still one bounded coordinator
lifecycle, not one per project. No new dependency, migration, endpoint, key or permission.

## Operator responsibilities

Every entry must be separately reviewed for its actual project, acceptance profile,
executor, credential reference, destination and expiry. The profile must already be
registered with the correct project/digest; startup does not create it. Retain the
existing shared integrity keys and independently backed checkpoint configuration.
Do not construct production authority by changing another template's project ID.

Promoting an Idea or saving its initial task does not configure execution. This block
allows multiple explicitly prepared projects, not automatic setup for arbitrary new
ones. New plans still need assignment and fresh bounded native approval/submission.
Removing a template stops new planning under it; it is **not** cancellation or revocation
of saved jobs, leases or previously approved packets. Those retain their existing
expiry, cancellation, revocation and recovery rules.

## Verification commands and limits

- `pnpm test:multi-project`: new exact-project checks and planning/revision/startup regressions.
- `pnpm test:multi-project:build`: fresh artifact plus compiled multi-project and related checks.
- The new tests also appear in the existing main/source and VPS build inventories.

Evidence uses disposable PGlite, actual restricted SQL roles and injected application
installation. Template/profile preparation is synthetic and explicit. In-process
overlap does not establish physical PostgreSQL concurrency. Result reconstruction
replays a previously registered fixture result, not a new live result ingestion.
No provider, listener, real owner signing, external database, deployment or fleet
qualification is performed. See the overnight log for executed results and corrections.
