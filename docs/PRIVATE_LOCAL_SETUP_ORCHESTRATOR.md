# Private local setup orchestrator

**Status:** source-only dispatcher over accepted installation contracts. It has
not installed a database, created an owner directory, created an owner, run a
backup or restore, installed a service, opened a browser, or started a worker.

## Reuse decision

This package implements the guided-setup row in
`INSTALLATION_REUSE_IMPLEMENTATION_MAP.md` by reusing the existing components:

- `installation-plan.ts` and `installation-plan-journal.ts` remain the only
  state machine and durable store;
- `local-installation-prerequisite-transaction.ts` remains the earlier launcher-owned
  release and private-placement settlement path and is deliberately outside
  this owner-effect dispatcher;
- the PostgreSQL, protected-data, and first-owner private runners remain the
  only effect boundaries, and their existing terminal transactions remain the
  only way those stages can pass; and
- every owner confirmation remains inside its stage runner and is bound to the
  exact request. The dispatcher cannot accept a browser boolean as attendance.

No donor coordinator, database, scheduler, receipt store, browser endpoint,
native command, or automatic retry mechanism was added.

## Dispatch rule

`dispatchPrivateLocalSetupStageV1` reads the journal tip and requires the
caller's exact installation ID, topology, release digest, plan digest, and plan
revision. It dispatches only the first owner-effect setup stage. Release
preflight and private placement must already have been settled by their retained
launcher transaction; this dispatcher refuses while either remains incomplete.
A changed identity,
revision, release, stage, source record, runtime shape, or journal reply refuses
before owner confirmation.

An effectful stage is moved to `running` and completed in the same dispatcher
call. PostgreSQL's provision, migration, and final-evidence operations remain
one database stage and run in their existing order. Each operation independently
requires its existing owner-attached confirmation and exact release and ledger
verification. Protected-data and first-owner similarly use only their accepted
runner plus terminal settlement.

If a call is cancelled, loses a reply, or becomes uncertain, no dispatcher
retry occurs. The journal remains `running`; a later dispatch refuses and the
owner must inspect it. This deliberately favors a visible stop over duplicating
an effect.

## Deliberate stops

Recovery is returned as `recovery_private_adapter_missing`. Its newly accepted
source runner and settlement contract deliberately supply no production
backup/restore adapter, and this dispatcher does not import concurrent work
until its integration is independently accepted.

Even after a future accepted recovery settlement, the service stage returns
`macos_native_service_port_missing`. The source-only service runner does not
supply the separately reviewed launchd/filesystem/process implementation, so
the dispatcher cannot install or start the service.

The focused adversarial tests cover exact first-owner dispatch and settlement,
foreign installation/release/revision/stage substitution, the visible recovery
stop, single-winner concurrent dispatch before owner effects, and refusal to
repeat a stage after an uncertain ceremony attempt.
