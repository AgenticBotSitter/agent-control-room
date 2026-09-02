# CR13A-LIVE-040 independent security and integrity review

**Disposition:** `rejected`

## Review identity and scope

- Immutable base: `10605afd4a5e8d3baeafeab82ec883f6008e845b`
- Immutable product target: `6493118f2b7272308d3c508b963f3ddd52cc9863`
- Reviewer was independent of the producer and prior CR13A reviewers.
- Review followed the report-only, zero-repair boundary.
- No prior review conclusions were treated as evidence.

## Deterministic reproduction

All required commands ran from an isolated clean checkout pinned exactly to the product target:

- Stage zero: exit `0`, `ready_for_runtime_check`
- TypeScript `--noEmit`: exit `0`, no output
- Full ESLint: exit `0`, no output
- Protocol/intake/delivery suite: exit `0`, `23/23` passed
- Combined connection/activity suite: exit `0`, `42/42` passed
- Migration verification: exit `0`; migrations `0001`–`0036` applied; `119 PostgreSQL tables` verified
- Exact `git diff --check`: exit `0`, no output

The passing producer tests do not override the following findings.

## High findings

### H-001 — Post-import ambient mutation bypasses delivery-ledger HMAC authentication

Evidence:

- `src/connection-registry/v1/node-delivery.ts:100-103` dynamically resolves global `Buffer.from` whenever authentication
  tags are compared.
- The unsafe comparison protects the head at line 343 and every delivery row at line 373.
- The new boundary also dynamically resolves mutable regex, date, JSON, object, and number operations after import,
  including lines 107-108, 342, 364-365, 490, and 533.
- This contradicts the established frozen host-operation boundary in ADR-110J through ADR-110M and the packet's explicit
  post-import-mutation attack requirement.

A private read-only probe supplied a structurally and digest-valid stream with forged same-length HMAC tags:

```json
{"baseline":"integrity_failed","mutated":"delivery:ambient-probe"}
```

The only change between attempts was a post-import replacement of `Buffer.from` that returned equal buffers for
HMAC-shaped strings. The wrong-key/forged-tag stream changed from rejection to acceptance.

A second probe confirmed that replacing `RegExp.prototype.test` after import bypasses the public `read()` identifier
guard and reaches the database transaction:

```json
{"transactions":1,"queries":1,"name":"ConnectionEnrollmentNodeDeliveryErrorV1","safeCode":"integrity_failed"}
```

Exploit/failure path:

1. Product module is imported.
2. Another same-process component mutates an ambient helper.
3. A wrong integrity key or forged database head/row supplies a same-length fake HMAC.
4. The mutable conversion makes the fake and expected tags compare equal.
5. `read()` returns protected delivery evidence that was not authenticated by the configured ledger key.

Required remediation:

- Capture and verify every required host operation at module initialization.
- Perform tag conversion with a captured native operation or immutable byte comparison.
- Replace direct regex calls with captured native `RegExp.prototype.exec`.
- Capture chronology, JSON serialization, reflection, object-freeze, and numeric conversion operations used by this
  boundary.
- Add a hostile regression proving wrong-key and forged-tag rows remain rejected with zero ambient calls after import.

## Medium findings

### M-001 — The published JSON Schema is not semantically equivalent to the runtime validator

Evidence:

- `contracts/control-room-node-v1-frame.schema.json:457` emits `"envelope": {}`, accepting any JSON value.
- The same schema advertises both directions at lines 348-353 and both sender kinds at lines 385-390.
- Runtime validation requires an object envelope, inner body and attestation objects, matching
  contract/tenant/node/connection/key scope, and matching envelope digest at
  `src/node-protocol/v1/schemas.ts:102-110` and `346-367`.
- Runtime direction authority allows this type only in `nodeToServerTypes` at line 371.
- The existing parity test at `tests/node-protocol.test.ts:209-213` only compares the committed artifact to the same
  lossy generator.

A runtime probe using a scalar envelope produced:

```json
{"runtimeAccepted":false,"issues":[{"path":["body","envelope"],"message":"enrollment envelope must be an object"}]}
```

The committed JSON Schema accepts that envelope structurally.

Exploit/failure path:

- A node or secondary implementation validates against the published schema and accepts a scalar, cross-scope, or
  wrong-direction delivery.
- The actual server rejects it under stronger rules.
- Any consumer treating the generated schema as the stated exact protocol contract lacks the new identity-binding
  guarantees.
- The acceptance claim that runtime and generated schema both reject drift is therefore false.

Required remediation:

- Generate a strict structural envelope schema.
- Make direction `node_to_server` and sender kind `node` explicit for this variant.
- Clearly separate non-representable cryptographic/cross-field checks from structural JSON Schema guarantees.
- Add a shared negative corpus evaluated by both the generated-schema validator and runtime validator.
- Correct the acceptance language unless exact semantic parity is mechanically demonstrated.

### M-002 — Exact replay does not preserve the original authenticated receive chronology

Evidence:

- Protocol replay persists `received_at` in `node_protocol_replay`, but
  `ProtectedEnrollmentReplayGuardV1.consume()` returns only `"accepted"` or `"duplicate"` at
  `src/connection-registry/v1/node-delivery.ts:236-286`.
- On every attempt, the adapter rebuilds protected delivery evidence using the caller's current `options.receivedAt` at
  lines 441-443.
- An existing duplicate requires the recomputed protected-delivery digest and `row.received_at` to equal the new attempt
  time at lines 464-471.
- The producer recovery test reuses the same fixed `deliveryOptions()` timestamp for every attempt at
  `tests/connection-enrollment-node-delivery.test.ts:284-293`.

Exploit/failure path:

- A ledger commit succeeds but its response is lost.
- The process restarts and retries the exact signed frame with a newly observed server receive time.
- Protocol replay correctly returns `duplicate`.
- The delivery ledger rejects the same frame as `replay_conflict` because the protected-delivery digest and timestamp
  changed.
- If the first ledger append failed, retry may append using the later timestamp rather than the durable protocol replay
  timestamp, so the two stores disagree about when authentication occurred.

Required remediation:

- Return the original durable replay `received_at` with duplicate disposition.
- Build or recover delivery evidence from that canonical timestamp.
- Return the original ledger receipt for a successfully committed duplicate.
- Add restart-style tests using distinct receive times for both response-loss and missing-ledger recovery.

## Low findings

### L-001 — A protocol-valid short delivery ID is rejected only after replay consumption

Evidence:

- The node protocol `id` accepts one-character identifiers at `src/node-protocol/v1/schemas.ts:8`; delivery uses that
  schema at line 103.
- The generated JSON Schema likewise sets `deliveryId.minLength` to `1`.
- The protected delivery builder requires the separate minimum-three-character pattern at
  `src/connection-registry/v1/intake.ts:26` and `188-189`.
- `deliver()` calls that builder after protocol authentication and replay consumption at
  `src/connection-registry/v1/node-delivery.ts:416-443`.
- The builder error is not translated into `ConnectionEnrollmentNodeDeliveryErrorV1`.

Failure path:

- A correctly signed frame with `deliveryId: "a"` passes protocol schema, signature, and replay persistence.
- The downstream builder rejects it.
- The protocol sequence is consumed without a delivery record, and the adapter exposes the wrong boundary error class.

Required remediation:

- Use one dedicated delivery-ID contract consistently in the protocol schema, generated schema, adapter, migration,
  and intake.
- Reject invalid delivery IDs during protocol parsing before replay consumption.
- Map all downstream construction failures to the adapter's safe error type.
- Add a regression covering the shortest and longest accepted identifiers.

## Mandatory attack-question answers

1. Forged, expired, future-version, wrong-direction, revoked, quarantined, rate-limited, oversized, and structurally
   malformed outer frames do not reach delivery persistence. However, L-001 permits a schema-valid but downstream-invalid
   delivery ID to consume replay state before rejection.
2. Signed frame material binds tenant, node, key, connection, direction, sequence, nonce, message ID, declared contract,
   delivery ID, and envelope digest. Full contract acceptance remains post-replay, and L-001 shows the delivery-ID domain
   is not consistently validated.
3. No. An invalid, drifted, cross-scope, expired, or attacker-key inner envelope cannot create a registry record.
   CR13A-LIVE-030 independently resolves the active database key and verifies the inner Ed25519 signature.
4. No second ledger or registry record was found through replay, nonce reuse, message reuse, delivery reuse, collision,
   gap, or changed-content replay. M-002 means a legitimate exact retry with a later server timestamp fails instead of
   returning its durable duplicate result.
5. Not safely enough for acceptance. Missing-ledger recovery works only without preserving the original durable replay
   chronology, and a committed response-loss retry conflicts when server time changes. See M-002.
6. No. Normal concurrency, ordering, deletion, truncation, payload substitution, and wrong-key checks fail closed, but
   H-001 permits wrong-key or forged-tag evidence to bypass both head and row authentication after post-import ambient
   mutation.
7. No. Proxy/accessor and behavioral database probes were rejected without executing traps, and normal errors are
   sanitized. H-001 demonstrates post-import behavior execution and validation/HMAC bypass. L-001 also escapes the
   adapter's intended error class.
8. Yes. The receipt exposes only derived references, digests, chronology, duplicate dispositions, and false authority
   fields. It omits the listed protected identities and grants no approval, network, command, lease, or execution
   authority.
9. No. The committed JSON Schema is materially weaker than runtime validation and does not encode the new message's
   one-way direction. See M-001.
10. No browser/HTTP write route, listener, connector, SSH/Hermes/native launch, credential access, provider call,
    production PostgreSQL/VPS contact, deployment, or network effect exists in the target.

## Effect and repository confirmation

- No product file was edited.
- No commit, push, branch, PR, or report file was created by the reviewer.
- The isolated target checkout remained clean and was removed after review.
- The shared checkout remained clean.
- No network, listener, SSH, Hermes, provider, credential, native, production database, or deployment effect occurred.

## Final disposition

`rejected`

The exact product contains one High, two Medium, and one Low finding. It grants no integration, listener, enrollment,
connector, native, provider, production, or deployment authority.
