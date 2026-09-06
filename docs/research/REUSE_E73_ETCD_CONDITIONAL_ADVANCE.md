# E73 — conditional checkpoint advance preparation

2026-09-06. Pure request preparation; no write dispatch, dependency change or service.

`prepareEtcdCheckpointAdvance` reuses E72 record validation and the existing checkpoint
digest/schema functions. Before preparing a write it requires the expected digest,
same scope and exactly the next application revision. The upstream transaction compares
key creation revision, last modification revision, exact original value bytes and no
lease, then puts one new checkpoint. The failed-comparison branch is empty. Keys and
values are copied so later input-buffer mutation does not alter the prepared request.

## Real issue corrected during protocol verification

E70's original synthetic comparison used enum strings `VALUE`/`EQUAL`. The retained
protocol instead names these `Value`/`Equal`. The earlier test verified payload bytes
but not enum identity; it therefore did not prove that a value comparison was encoded.
That overbroad implication is corrected here. No deployed/application write used it.

The new mapper uses upstream numeric values for Create (1), Mod (2), Value (3), Lease
(4), all Equal (0). Actual upstream serialization/deserialization now explicitly
asserts all target/result enums, exact bytes, generation/modification revisions, lease,
new application revision and absence of failure-branch writes. The original diagnostic
also uses correct enum names and asserts them. No custom protobuf implementation.

## Evidence and limits

- Five record/mapping unit tests pass, including copied prior bytes and refusal of
  stale digest, wrong scope, repeated and skipped application revisions.
- 38 combined record/adapter/staging/database checks and seven package diagnostics pass.
- Targeted lint and VPS build pass. Initial TypeScript found array-union indexing in
  the tests; preserving the fixed comparison sequence as a tuple resolves it without
  weakening assertions or changing protocol behavior.
- Final TypeScript passes. Full default lifecycle and compiled suites were not rerun
  for this unwired pure mapper; no new broad-runtime acceptance is claimed.

This verifies request construction, not etcd atomicity, durable persistence or actual
one-winner concurrency. It does not enforce a monotonic-only policy against an arbitrary
writer with direct store credentials. Trusted endpoint/permissions, independent binding,
transaction result validation, read/advance transport composition and initialization
remain open. Cluster identity checked after a write cannot substitute for authenticating
the endpoint before dispatch. Split SQL/anchor failure must remain explicit uncertainty.
