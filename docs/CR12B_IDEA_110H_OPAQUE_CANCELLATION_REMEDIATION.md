# CR12B-IDEA-110H — opaque cancellation remediation

**Status:** Implementation frozen at `d22c76444b80f8dd469380aab52ec457f5d76fad`; provider-disabled and awaiting a
fresh independent review.

**Review packet:** `docs/reviews/CR12B_IDEA_110H_OPAQUE_CANCELLATION_REVIEW_PACKET.md` at SHA-256
`4800d632123fc1d97a98ed4a3e887e7502520461ba3ce4533c718b1625acb4eb`.

## Why IDEA-110G remained rejected

The original IDEA-110F report remains the last complete connector review and retains disposition
`remediation_required` at SHA-256
`d9a1acb60b3a272a71469fc07574db2d504100f7a382fb33a702a50c585b5808`. Two later review jobbers
started against IDEA-110G but their reviewer processes stopped before a complete report could be published. Their
GitHub queue records are preserved as `blocked_incomplete_review`; neither attempt is acceptance evidence.

Before the first interruption, a different reviewer identified a real remaining High cancellation defect. A genuine
Node `AbortSignal` could preserve the expected own-key shape while its internal event-map data value was replaced with
a Proxy. The IDEA-110G shape check accepted the signal, and the captured native listener operation executed one
caller-owned Proxy trap. Codex reproduced the sanitized result exactly as
`{"accepted":true,"added":false,"traps":1}`. This rejects IDEA-110G even without a complete whole-packet report.

## Structural repair

IDEA-110H removes native `AbortSignal` objects from every repository component seam between the filtered driver,
enrolled gateway, fixed bridge, and macOS connector. Those seams now carry one repository-created opaque cancellation
capability:

- the signal is a frozen, zero-own-key object whose state lives only in a module-private `WeakMap`;
- exact validation requires private registry membership, the frozen private prototype, zero own keys, and a non-Proxy
  object;
- abort state and subscriptions use captured intrinsics over repository-private arrays, never EventTarget,
  AbortSignal internals, caller accessors, iterators, or caller-owned containers;
- cancellation is one-way and idempotent, and a pre-aborted capability dispatches nothing;
- only the connector's Mac-private port receives a new connector-owned native `AbortSignal`, because that final local
  adapter may need the host cancellation API; no native signal returns across the repository seam;
- connector settlement uses its own cancellation bit rather than re-reading mutable native signal internals after the
  private call.

The regression suite passes the exact poisoned native signal to the connector boundary. It is rejected without reading
the poisoned map, executes zero Proxy traps, and dispatches zero private calls. Separate tests prove the opaque signal is
frozen, Proxy-rejecting, one-use, pre-abort safe, and still propagates timeout and cleanup cancellation through the full
driver/gateway/bridge/connector lifecycle.

## Current evidence and limits

Stage zero, TypeScript, full lint, 49/49 cancellation/gateway/bridge/connector/readiness tests, and the combined CR12B
suite at 154/154 pass. The complete repository lifecycle passes 769/769 pretests, 414/416 core tests with two intentional
platform skips, and 233/233 posttests. The production build and 3/3 rendered routes pass. All 32 migrations and 110
PostgreSQL tables verify, and whitespace validation passes.

No install, download, Hermes process, SSH connection, provider call, credential or protected-value access, Keychain
operation, private-port configuration, signed enrollment, production database contact, deployment, hosting, DNS, or
other external effect occurred.

The connector remains unaccepted. A fresh reviewer must independently reproduce the poisoned-signal case, repeat the
entire original IDEA-110F matrix plus the IDEA-110G matrix, and review the opaque capability implementation and all four
component seams under the exact packet above. Only an accepted immutable report can remove
`connector_implementation_unaccepted`. Trusted signer
enrollment, one signed connection enrollment, effect-free preflight, packet refresh, fresh owner authorization, and the
owner-attended native qualification remain separate later gates.
