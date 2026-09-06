# E74 — joined read/conditional advance/receipt path

2026-09-06. No new download, channel creation, service or runtime host wiring.

The supplied-transport `createEtcdCheckpointAccess` combines E71–E73 for one already
provisioned checkpoint: exact-key current read, schema/generation validation, expected
digest and next-revision checks, one conditional transaction, then receipt validation.
The read and write share an absolute RPC deadline. Local waits are bounded and late
completion is refused. Both operations require an explicit AbortSignal; transport
methods are captured and trusted binding/key bytes are snapshotted at construction.

Receipt validation requires a successful single-Put transaction, expected outer
cluster identity and a strictly newer storage revision. Wrong/missing/extra operation
responses, wrong cluster, failed comparisons and invalid revision representations
are rejected. Nested Put headers are not used as authority; the outer transaction
header is validated. Lost/malformed responses never trigger automatic retries.

The access layer intentionally has no initialize operation, endpoint discovery or
fallback. It is not presented as the complete production storage port. Trust setup,
permissions, independently preserved binding and initial creation still need explicit
design/qualification. An already provisioned test record is not evidence of that setup.

## Verification

- Nine record/mapping/access tests cover success, negative receipt shapes, stale digest
  refusal before write, failed comparison without retry and canceled read preventing
  any later write. Prior record negative cases remain.
- Actual retained upstream Txn codec accepts the receipt parser, including oneof
  decoding/default values. This is offline protocol compatibility, not a live ack.
- Targeted lint and VPS build pass. No schema, compiler target or application dependency
  changes. Final TypeScript passes; combined focused/adjacent tests: 42 pass; retained
  package diagnostics: seven pass. Full default lifecycle and compiled suites were
  not rerun; these unwired-module checks do not establish broad runtime acceptance.

## Remaining acceptance

The supplied transport must authenticate the endpoint before writing and disable
channel retries; no JS wrapper proves this. Receipt cluster checking after dispatch
does not prevent effects on a misconfigured endpoint. Binding cannot be learned from
the returned data. Initialization, independent restore handling, partial anchor/SQL
failure and real-service restart/concurrent-CAS tests remain required. The access layer
does not turn an arbitrary key-write permission into a server-enforced monotonic API.
