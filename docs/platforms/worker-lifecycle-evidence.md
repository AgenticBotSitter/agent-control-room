# Mac/Linux worker lifecycle evidence

The issue #125 evidence is a disposable rehearsal of the existing worker boundaries. It is not a live-worker qualification and does not claim that Hermes or Codex was installed, authenticated, enrolled or contacted.

## Reused components

- `normalizeStaticDiscovery` supplies the canonical, sanitized platform inventory and fingerprint.
- `evaluateFleetEligibility` keeps stale telemetry, insufficient storage and missing or unverified capabilities out of readiness.
- The shared connector profile contract decides which operations have sufficient evidence to be available.
- `SqliteBridgeJournal` and `SqliteCodexStartJournalV1` provide the real private journal formats, while `openPrivateCodexConfigurationV1` reopens the exact checked files for the bounded recovery rehearsal.
- `createCodexReadRecovery` projects a read of only the exact recorded thread and turn, with usage remaining `unknown`.
- `runPrivateNode` supplies the existing one-shot entry, cancellation, late-acquisition ownership and bounded drain behavior.

The preparation checker accepts facts; it never gathers them by launching a harness. Its output omits the endpoint, paths, capacity details and integrity manifests. It grants no authority.

`tests/private-worker-preparation.test.mjs` is the complete sanitized Mac/Linux input example. It uses invented identities and digests and may be copied as a shape reference; none of its values are deployment defaults.

## Rehearsed cases

The focused tests and `scripts/test-private-worker-lifecycle.ts` use only owner-created temporary directories, private SQLite files and injected fake resources. They demonstrate:

1. Exact macOS and Linux platform, architecture, runtime version/integrity, connector profile and tenant/node/endpoint bindings can pass; a missing, changed or unsupported fact refuses.
2. Stale telemetry, unverified capability evidence and unsupported connector operations cannot become ready. Usage is `unknown`, not an invented zero.
3. An interruption after the thread receipt leaves `thread_recorded_turn_unknown`. Reopening the journal preserves that state and cannot authorize a read, retry, resume or duplicate start.
4. A fully recorded synthetic thread and turn can be projected through the existing read-recovery contract. The result remains a noncanonical observation and does not verify completion.
5. Revocation at the journal authority boundary leaves no new admission.
6. The private-node launcher's Codex and Hermes branches each accept exactly one bounded synthetic attempt. No provider or native interface is loaded.
7. Cancellation while configuration acquisition is pending closes the one late-acquired fixture and never calls its run operation.
8. Failed drain returns an explicit cleanup-uncertain failure. It does not retry and does not convert the attempt to success.

The executable evidence intentionally reports zero provider calls, credential reads, persistent services and automatic restarts. It contains no host identity, private address, credential, path or result content.

## Remaining boundaries

This package does not implement the final server endpoint, real Hermes behavior, Codex canonical publication or cross-machine acceptance. It does not authorize a native attempt. Those remain owned by their separate accepted packages and operator gates.
