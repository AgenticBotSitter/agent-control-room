# CR12B-IDEA-110I — exact cancellation-boundary remediation

**Status:** Rejected by independent review with one Medium host-operation-capture finding. Superseded by IDEA-110J; see
`CR12B_IDEA_110J_HOST_OPERATION_CAPTURE_REMEDIATION.md`.

**Replacement review packet:** `docs/reviews/CR12B_IDEA_110I_CANCELLATION_BOUNDARY_REVIEW_PACKET.md` at SHA-256
`1e16228a82d475941507213593c900ec94e0092054c53bdb9fcd18e97536e1ef`.

## Why IDEA-110H remained rejected

Independent PR #219 reviewed exact IDEA-110H implementation `d22c76444b80f8dd469380aab52ec457f5d76fad`
and returned `remediation_required`. Its durable report is
`docs/reviews/CR12B_IDEA_110H_OPAQUE_CANCELLATION_REVIEW_REV_001.md`. It preserves three blocking findings:

1. a native or otherwise non-opaque signal reached gateway validation only after the one-use permit was claimed, and
   gateway/bridge cleanup could forward the same invalid signal across component seams;
2. the Mac-private port could mutate the connector-owned native signal so abort threw caller-controlled behavior during
   route close, escaped safe error replacement, and interrupted mandatory settlement and cleanup; and
3. native conversion resolved the ambient `AbortController` after an opaque capability had already been accepted, so a
   post-import global substitution could execute and leak its thrown object.

The review made no native, provider, credential, SSH, deployment, or production effect. Its passing producer tests did
not override the reproduced defects.

## Structural repair

IDEA-110I treats cancellation as exact data at every repository seam and native abort as a contained host operation:

- gateway execute and cleanup snapshot exact ordinary data and require a repository-minted opaque signal before reading
  lifecycle state, trusted time, spending a permit, settling, or calling the bridge;
- fixed-bridge execute and cleanup apply the same rule before changing lifecycle state, creating a child capability, or
  calling any connector operation;
- Proxy, accessor-bearing, native, forged, extra-key, inherited, and non-ordinary wrappers therefore cannot consume the
  permit or cleanup opportunity and cannot reach a collaborator;
- the Mac connector captures the native controller constructor, signal getter, abort method, and apply operation at
  module initialization; later ambient-global or prototype substitution is not selected;
- connector-owned cancellation state becomes terminal before native abort runs; abort failure is caught and discarded,
  the active operation is still joined, and mandatory cleanup remains reachable;
- the native signal stays private to the Mac port, and neither it nor a host exception crosses back into the repository
  protocol.

## Regression evidence

Four new hostile tests reproduce the independent findings:

- gateway Proxy/native input executes zero traps, creates zero spend records, and makes zero bridge calls; invalid
  cleanup leaves the valid cleanup opportunity available;
- bridge Proxy/native input executes zero traps and makes zero connector calls; invalid cleanup leaves the valid cleanup
  opportunity available;
- a private port poisons the final native event map, native abort executes inside the bounded catch, late execution is
  safely rejected, and the exact cleanup sequence plus route close still completes;
- replacing `globalThis.AbortController` after module import executes the hostile constructor zero times while the
  captured native path remains usable.

Verification passes 158/158 CR12B tests, 769/769 pretests, 414/416 core tests with two intentional platform skips,
237/237 posttests, TypeScript, full lint, production build, 3/3 sequential rendered routes, 32 migrations/110 PostgreSQL
tables, macOS stage zero, and whitespace validation. The first rendered-route invocation raced the concurrent builder and
could not find a chunk while `dist` was being replaced; the identical check passed 3/3 after the build completed. No code
repair followed that ordering-only failure.

## Remaining gates

Independent review reproduced all three prior findings as closed but found a separate dynamic ambient `Set` constructor
after cancellation acceptance. The exact candidate remains rejected; see
`docs/reviews/CR12B_IDEA_110I_CANCELLATION_BOUNDARY_REVIEW_REV_001.md`. Trusted signer enrollment, one signed connection
enrollment, effect-free preflight, packet refresh, fresh owner authorization, owner-attended native qualification,
live-panel authority, production PostgreSQL, hosting, and deployment remain separately blocked.

No install, download, Hermes process, SSH connection, provider call, credential or protected-value access, Keychain
operation, private-port configuration, production database contact, deployment, hosting, DNS, or other external effect
occurred in IDEA-110I.
