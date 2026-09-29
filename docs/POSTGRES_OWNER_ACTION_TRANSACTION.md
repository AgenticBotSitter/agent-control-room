# PostgreSQL owner-action terminal receipt

**Status:** source-only transaction boundary. It invokes no PostgreSQL tool,
process, service, network, credential store, or native integration.

`startPostgresOwnerActionV1` first refreshes the existing setup plan with the
exact release, migration-ledger, and target-identity digests, then appends the
`database_authority` `running` revision. Only after that durable transition can
the existing preparation and redacted owner-action seams be used. Replaying an
already-running stage supplies recovery information only; it never authorizes a
new tool attempt.

`confirmPostgresOwnerActionTerminalV1` accepts only the final
`collect_existing_database_evidence` request and an opaque terminal-evidence
digest from a later private owner wrapper. Provisioning or migration may move
the privately observed target to its next state, but cannot mark the whole
database-authority stage complete. The wrapper must verify the exact reviewed
release and migration ledger before it calls any existing PostgreSQL tool (the
migration applier bootstraps before it checks all migration bytes), suppress raw
targets and tool output, and validate substantive evidence through reviewed
glue after provision, migration, and evidence collection. This source boundary
never treats a command return, browser value, or unverified owner assertion as
terminal evidence.

The journal's exact replay result must name the caller's installation id on
every start, confirmation, and recovery path. Provisioning and migration never
settle `database_authority`: only the `collect_existing_database_evidence`
operation can record its terminal receipt. An older receipt also stops being
replayable when a later plan refresh resets that stage; the current plan must
still carry the same passed receipt digest.

The existing append-only installation-plan journal is the only durable receipt
store. Confirmed final database evidence advances the already-running
`database_authority` stage to `passed`, using a receipt digest derived from the
exact action request and terminal evidence. An exact restart reconstructs that
same receipt from the retained plan history. A changed request, changed
evidence, stale plan, missing confirmation, or `uncertain`/failed terminal
state is refused. No second ledger, PostgreSQL schema, effect engine, or retry
loop is introduced.

If the external wrapper loses terminal certainty after invoking a real tool,
it must leave the stage for owner attention rather than call this confirmation
boundary to guess a pass or retry the tool.
