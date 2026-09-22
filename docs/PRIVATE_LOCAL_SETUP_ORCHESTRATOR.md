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
- the PostgreSQL, protected-data, first-owner, and recovery private runners remain the
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
verification. Protected-data, first-owner, and recovery similarly use only
their accepted runner plus terminal settlement. Recovery accepts only an exact
injected private runtime for the existing owner-attended backup/restore
rehearsal; the dispatcher supplies no production adapter of its own.

For recovery, the dispatcher deep-copies and freezes the exact source record
and captures bound runtime callables before its first journal read. It then
builds the candidate `running` action and reuses the recovery preparation and
runtime validators before publishing that revision. A malformed source,
binding, or callable therefore refuses without changing the journal; caller
mutation during an awaited journal read cannot substitute either evidence or
runtime behavior.

If a call is cancelled or becomes uncertain before durable terminal settlement,
no dispatcher retry occurs. The journal remains `running`; a later dispatch
refuses and the owner must inspect it. If only the settlement append reply is
lost after the exact passing revision was durably published, the accepted
transaction rereads that revision and completes without rerunning the rehearsal.
This deliberately favors a visible stop over duplicating an effect.

## Deliberate stops

Recovery is returned as `recovery_private_adapter_missing` when no recovery
runtime is supplied. If private composition explicitly injects the exact
accepted recovery runtime, the dispatcher starts the recovery stage once,
accepts only its terminal combined disposable-restore proof, and settles it
through the existing journal transaction. An uncertain rehearsal remains
`running` and cannot be retried by a later dispatch. No production
backup/restore adapter is supplied by this package.

After an accepted recovery settlement, the service stage still returns
`macos_native_service_port_missing`. The source-only service runner does not
supply the separately reviewed launchd/filesystem/process implementation, so
the dispatcher cannot install or start the service.

The focused adversarial tests cover exact first-owner and recovery dispatch and
settlement, foreign installation/release/revision/stage substitution, the visible
recovery stop when the private adapter is absent, single-winner concurrent
recovery dispatch, immutable source and callable capture across journal awaits,
malformed recovery input leaving the journal unchanged, recovery after a lost
settlement reply without rerunning the rehearsal, and refusal to repeat a stage
after an uncertain owner or recovery attempt.
