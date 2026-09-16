# Remote artifact return

RES-007. A bounded boundary for an artifact coming back from an **approved**
upstream transport — SSH or sandbox — over the existing terminal-result and
durable artifact services.

Module: `src/harness/v1/remote-artifact-return.ts`
Tests: `tests/terminal-result-evidence.test.ts` (RES-007 cases)

## The one rule

**The transport is a carrier, not an authority.** It can hand over bytes and
nothing more. It cannot publish, complete, release capacity, permit retry or
resume, or grant execution authority. Every receipt this module produces pins
those flags to `false`, so a delivery can never be mistaken for a decision.

## What is reused, not restated

The existing artifact rules are called, not copied:

- **`resultBytesHash`** (`src/artifacts/v1/native-results.ts`) — the repo's real
  byte-level SHA-256. Note that `sha256Digest` canonicalises JSON and is *not* a
  byte hash; artifact content digests must use `resultBytesHash`.
- **`checkedResultBytes`** — the existing gate for the 64 KiB bound, exact size,
  byte digest, strict UTF-8 (including a round-trip byte comparison) and
  secret-material rejection.

Reusing them means a change to those rules cannot leave this boundary quietly
accepting bytes the rest of the system would refuse.

## Flow

A caller supplies an already-approved **transport descriptor**, the
**reservation** the artifact must satisfy, and the **delivery** it already
collected. The module decides accept or refuse; it opens nothing itself.

Check order is deliberate:

1. **Transport shape** — a descriptor that fails validation is refused.
2. **Transport support** — a transport that cannot carry this source kind is
   refused by name, never treated as unknown-but-probably-fine.
3. **Capabilities** — any required capability the descriptor does not declare is
   refused, because proceeding would accept bytes under a delivery guarantee
   that was never promised.
4. **Identity** — the descriptor is bound to one exact source identity through
   `sourceIdentityFingerprint`.
5. **Run freshness** — a lease epoch behind the reservation's current epoch is a
   stale run and is refused rather than accepted late.
6. **Reservation window** — a return observed after expiry is refused.
7. **Delivery integrity** — disconnect, truncation, the transport's own digest
   claim, then the reused content gate.
8. **Duplicate handling** — replay or conflict.
9. **Terminal evidence** — must be valid *and* belong to the same run.
10. **Cleanup** — uncertain remote cleanup refuses, even when the bytes are good.

## Outcomes

Accepted: one receipt carrying the exact identity, content digest, size and
transport, with the canonical `returnId` derived from identity + digest + size.

Refusals are named and always carry `receiptProduced: false`:

| Outcome | Meaning |
| --- | --- |
| `transport_descriptor_invalid` | Descriptor failed validation |
| `transport_unsupported` | Transport cannot carry this source kind |
| `capability_unsupported` | A required capability was not declared |
| `reservation_missing` | Reservation failed validation |
| `identity_mismatch` | Delivery or evidence belongs to another run |
| `run_stale` | Artifact from a superseded lease epoch |
| `reservation_expired` | Observed after the reservation window |
| `disconnected` | Carrier dropped mid-transfer |
| `truncated` | Fewer bytes than declared, carrier intact |
| `content_rejected` | Bytes failed the artifact gate |
| `content_conflict` | Changed content under the same identity |
| `cleanup_uncertain` | Remote copy removal unconfirmed |

`remoteArtifactMayRemain` marks refusals where the remote copy is *not* confirmed
removed — disconnect, stale run, expiry, conflict and cleanup uncertainty. Those
need operator attention; a truncation does not.

### Disconnect is not truncation

A dropped carrier ends the stream early; truncation delivers fewer bytes than
declared with the carrier intact. They are separate outcomes because the recovery
differs: a disconnect means the remote side may still hold the artifact, whereas
a truncation is a delivery fault. Collapsing them would lose that distinction.

### Replay is not overwrite

The same reservation returning the same bytes yields the recorded receipt
unchanged, with `replayed: true` — same `returnId`, same `receiptDigest`.
Changed content under the same identity is a **conflict**, never a silent
replacement of already-accepted work.

## Bounds

- One artifact per return, at most **65,536 bytes**, enforced through the
  existing gate.
- No SSH connection, sandbox, credential, network call, file deletion or live
  transfer occurs in this module.
- The receipt store is injected, so no storage or authority is assumed.

## What is verified, and what is not

**Source-tested here.** Eleven tests drive the real module with real bytes:

- exact identity, digest and size on acceptance, with every authority flag `false`
- unsupported transport, undeclared capability, unparseable descriptor
- disconnect distinguished from truncation
- wrong identity, stale run, expired reservation window
- exact replay returning the recorded receipt, and changed content conflicting
  without replacing the accepted receipt
- cleanup uncertainty refusing good bytes
- bytes contradicting the transport's own digest claim
- evidence belonging to a different run
- delivery byte-slicing at the drop point

**Not verified here.** No real SSH or sandbox provider was contacted, so nothing
below is claimed:

- that a real SSH or sandbox transport delivers the bytes it declares
- that a real carrier's disconnect behaviour matches the modelled drop point
- that a real transport's cleanup acknowledgement is trustworthy
- that `stream_digest` or `at_most_once_delivery` hold for any real endpoint

The transport capability flags exist precisely because these are *claims by a
transport*, not facts this boundary can establish. A real provider qualification
run is required before treating any of them as proven.

Checks: `pnpm test:contracts` 196/196 · `pnpm check` clean · `pnpm check:demo`
clean · lane coverage `all 210 test files are reachable from GitHub Actions`.