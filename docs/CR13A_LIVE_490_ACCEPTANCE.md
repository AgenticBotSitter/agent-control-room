# CR13A-LIVE-490 acceptance

**Disposition:** accepted for ordinary integration of the inert contract only

**Product commit:** `dc313b1f2ff5982fe0ffa3b505db36025036601f`

**Product tree:** `de7b73195fdbc4eb08097e2da7eb7cd97e4f48a3`

**Independent review:** `docs/reviews/CR13A_LIVE_490_INDEPENDENT_REVIEW.md`

**Independent review SHA-256:** `56b03b7941971c50867553dc26c65a74cb9e4e291ba1a2543f5a9ac2708b2eb7`

**Findings:** High 0; Medium 0; Low 0 after remediation of 3 High and 2 Medium

## Accepted result

The accepted product makes rooted trust, key rotation, deployment identity, and independent rollback protection
exact before any protected implementation exists. Its signature-free canonical root-rotation body and separate
dual-signature envelope remove circular signing. The registry and manifest policies identify the exact ordered signer
roles and require every signature to cover the same canonical body digest.

All 28 key roles use the accepted closed LIVE-480 binding schema. A second active revision is possible only through an
explicit signed per-role declaration binding old/new entries, a strictly increasing revision, a maximum 300-second
interval, the authorizing registry sequence, and the dependent manifest transition. Reuse, overlap, reversal, stale
reactivation, and inferred rotation are forbidden.

Each of the five rollback anchors is bound to a different adapter product, writer-key role, stream, protected
destination, and custody domain. CAS requests and receipts have closed fields, three exact settlements, and fixed
request/body/revision/head/deadline consequences. Unknown or uncertain outcomes create no receipt and quarantine;
recovery may reissue only the exact stored request and never reconstruct, sign, substitute, roll back, or activate.

The first independent review rejected the original product with 3 High and 2 Medium findings. All five were
remediated. A different independent reviewer accepted exact product
`dc313b1f2ff5982fe0ffa3b505db36025036601f`, tree
`de7b73195fdbc4eb08097e2da7eb7cd97e4f48a3`, with 0 High, 0 Medium, and 0 Low.

Focused verification passed 15/15; the existing CR13A suite passed 473/473; the complete repository lifecycle passed
769/421/392; all five build phases and 4/4 rendered routes passed; and migrations 0001-0038 verified 124 tables.
TypeScript, full lint, macOS stage zero, and whitespace validation passed.

## Remaining boundary

This block is vocabulary and exact singleton parsing only. It loads no owner root; creates, reads, rotates, revokes,
or destroys no key; signs or verifies nothing; reads or writes no registry, manifest, anchor, database, filesystem,
environment, clock, credential, source, provider, process, network, or native state; and wires no runtime. All 44
actual totals remain zero and all eight authority grants remain false.

The next safe dependency-ordered slice is an inert owner-present issuer and strong-factor evidence contract. A real
issuer, credential/key access, nonce generation, trusted time, signing, registration/nonce store, PostgreSQL,
independent anchor operation, capsule/provider/source/native/runtime work, hosting, and deployment remain separately
gated.
