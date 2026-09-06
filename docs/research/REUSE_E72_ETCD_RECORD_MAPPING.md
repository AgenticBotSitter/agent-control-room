# E72 — exact checkpoint read mapping

2026-09-06. Pure local implementation; no new acquisition, service or runtime wiring.

The new `parseEtcdCheckpointRecord` uses existing Zod and rollback-checkpoint parsing
to validate the decoded upstream Range response. It requires one complete, non-leased
record matching independently supplied cluster ID, key creation revision, exact key
bytes and checkpoint scope. Missing data never becomes automatic initialization.
Revision fields remain decimal strings and are compared with BigInt, not rounded
JavaScript numbers. Revision ordering and protocol integer bounds are checked.
Malformed UTF-8, oversized values and invalid checkpoint bodies are refused.

The result copies the exact prior value bytes for a later conditional write. It does
not reconstruct those bytes by reserializing JSON, which could change a comparison.
No protobuf codec is written: the existing retained upstream codec is used in the
package diagnostic. No client or production storage dependency is added.

## Evidence

- Three unit tests, including sixteen negative mutations, pass; combined adapter,
  staging and bounded-database regression run: 36 pass.
- Seven retained-package diagnostics pass, including the actual upstream Range
  serializer/deserializer feeding this parser with large identifiers and default
  fields. This is format compatibility, not a live etcd read.
- Targeted lint passes. Initial TypeScript rejected BigInt literal syntax under the
  existing compiler target; switched to equivalent BigInt string construction,
  preserving exact arithmetic rather than changing the project's compiler target.
- Final TypeScript and VPS build pass. Full default lifecycle/compiled suites were
  not rerun for this unwired parser; E71's previous compiled evidence is unchanged.

## Limits and next integration

Trusted binding is required input, not learned from the response. It still needs
independent provisioning, storage and restore policy. Generation comparison can
detect a different creation revision or cluster identity, but does not prove that a
same-identity raw disk rollback is impossible. A valid old record alone must not be
accepted as current; the consuming database/checkpoint consistency checks remain.

This is read-result validation, not a completed checkpoint store. Next implement
conditional advance mapping using prior exact bytes, expected digest, next revision
and key generation; integrate the bounded transport without implicit retries. Writes
must not rely on checking cluster identity only after dispatch as endpoint authority.
Real TLS, channel behavior, durability and split SQL/anchor outcome handling remain.
