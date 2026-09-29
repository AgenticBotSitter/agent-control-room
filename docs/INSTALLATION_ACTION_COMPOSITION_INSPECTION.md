# Installation action composition source inspection

**Scope:** source-only preparation glue for I2-I5. This note records the reuse
decision; it does not authorize installation, database, filesystem, service,
credential, worker, network, or native effects.

## Retained Control Room code

- `src/installer/v1/installation-plan.ts` remains the only setup-stage and
  revision authority. The composition verifies its exact current revision and
  does not create another plan or state machine.
- `src/installer/v1/installation-plan-journal.ts` remains the only private,
  pre-database plan journal. The composition neither imports nor replaces it.
- `src/installer/v1/postgres-setup-preparation.ts` remains the PostgreSQL I3
  planner and continues to bind the existing migration ledger and target
  identity without running SQL.
- `src/installer/v1/protected-data-recovery-preparation.ts` remains the I4
  planner for the existing protected artifact storage and backup/restore proof.
- `src/installer/v1/platform-service-lifecycle.ts` remains the I5 planner and
  retains the reviewed stop, bounded-drain, start-last, update, rollback, and
  data-preserving uninstall ordering.
- `src/harness/v1/installation-setup-wire.ts` and
  `src/installer/v1/installation-plan-view.ts` remain the browser-safe setup
  projections. The new composition is private installation code and adds no
  browser endpoint or effect handle.

These choices follow the retain/adapt rows in
`docs/INSTALLATION_REUSE_IMPLEMENTATION_MAP.md`. No donor source is copied or
materially adapted here, so no new third-party notice is required. The prior
T3-derived service-ordering concepts remain contained in the existing platform
service lifecycle component.

## Why thin custom glue is unavoidable

The retained I3, I4, and I5 planners deliberately have different trusted input
shapes and independently validate their own stage bindings. The setup flow
still needs one installation-owned boundary that takes one current I2 plan
snapshot, verifies its exact revision, release, and topology, selects one of
those existing planners, and returns one consistently redacted preparation.
None of the retained components performs that cross-package join, and importing
a donor coordinator would create a second plan, journal, or authority.

`src/installer/v1/installation-action-preparation.ts` is therefore limited to
that join. It stores nothing, invokes no callbacks, exposes no effect port, and
rejects extra source fields that could smuggle a command or credential. Its
output contains only existing digest-bound preparation records and abstract
operation names; it contains no path, password, connection string, operating
system command, service label, or executable argument.

## Deliberate limitations

- This does not execute an owner action or mark a stage passed.
- This does not read or append the installation journal.
- This does not create a protected data root, database, backup, restore,
  service definition, release switch, owner, credential, or worker.
- Trusted installation composition must still supply the current plan and the
  existing component-specific observations or evidence.
- The public release launcher, durable plan loading, owner-attended effect
  wrappers, and clean-install/upgrade acceptance journey remain separate work.
