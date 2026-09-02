# CR13A-LIVE-050 provider-disabled enrollment ingress acceptance

**Status:** remediation implementation candidate; exact freeze and different independent re-review required
**Effect boundary:** server-only repository composition and PGlite tests; no listener, HTTP/browser mutation, live
connector, SSH, Hermes/provider call, credential access, production PostgreSQL/VPS contact, deployment, or network effect

## Delivered boundary

`ConnectionEnrollmentNodeIngressCoordinatorV1` composes the independently accepted LIVE-040 authenticated node delivery
with the independently accepted LIVE-030 enrollment intake. A transport may supply one raw frame, a delivery-ID routing
hint, a server-held receive time, and transport identity. None of those caller labels becomes enrollment authority.

The coordinator first authenticates and durably stores the exact signed node frame through LIVE-040. It then re-reads
the protected delivery at the canonical durable replay time and proves that the routing hint resolves to the exact
delivery-evidence digest returned by authentication. Only that evidence may reach LIVE-030, which independently resolves
the current active database key and verifies the nested Hermes enrollment signature before registry persistence.

`DatabaseConnectionEnrollmentNodeIngressV1` is the production-shaped PostgreSQL-compatible composition. Delivery,
registry, and intake-audit HMAC keys must be separate 32-byte values. The class opens no listener and accepts no
credential or provider configuration. `DisabledConnectionEnrollmentNodeIngressV1` is the local runtime default, and the
application exposes no ingress port or enrollment write route.

## Replay, recovery, and failure rules

- An invalid routing ID fails before delivery or replay. A valid but mismatched routing hint cannot reach intake.
- Forged or malformed outer frames fail at node-protocol authentication.
- A valid outer frame with an invalid inner signature may create authenticated delivery evidence but cannot create an
  intake receipt or registry record.
- Delivery is durable before intake. If intake fails before commit, an exact later frame retry reuses the canonical
  delivery time and may complete intake once the definite local failure is repaired.
- Intake commits registry and audit evidence in one transaction. A response-loss replay returns the same combined safe
  receipt without another registry revision.
- Concurrent exact retries serialize through the existing replay, delivery, tenant, registry, and audit locks and return
  one stable receipt.
- Changed identity/content reuse, damaged evidence, duplicate key domains, behavioral input, behavioral database setup,
  receipt drift, or unclassified downstream failure closes with a bounded safe code.

## Safe receipt and negative authority

The combined ingress receipt contains only derived ingress/delivery/intake references, protocol/delivery/enrollment
digests, the registry revision, the canonical receive time, original protocol/ledger dispositions, one accepted
enrollment disposition, and explicit false values for approval, network, command, lease, and execution authority. It
contains no tenant, node, connection, delivery, enrollment, key, host, route, profile, public-key, signature, credential,
or transport identity.

The receipt is byte-stable across exact later and concurrent retries. It does not acknowledge a transport message,
authorize a connector, establish signal freshness, qualify a runtime, open a live panel, or grant work/effect authority.

## Deterministic evidence

- Mac stage zero: `ready_for_runtime_check`
- TypeScript: pass
- full ESLint: pass
- `tests/connection-enrollment-node-ingress.test.ts`: 9/9 pass
- complete connection slice: 37/37 pass
- complete repository lifecycle: 769/769 pretests, 419/421 core tests with two intentional platform skips, and 286/286
  original posttests plus two new remediation cases, 288/288 total
- migrations `0001` through `0036`: pass, 119 PostgreSQL tables
- production build: pass, 4/4 rendered routes
- exact whitespace gate: pass

The focused suite covers end-to-end enrollment, exact response-loss replay, outer/inner signature separation, routing-hint
binding, invalid hint before replay, intake failure and later recovery, concurrent exact retries, distinct HMAC key
domains, behavioral input/database rejection, disabled default, receipt drift, protected-value absence, and absence of
an app route/listener/port. Remediation adds a 20-operation post-import replacement matrix and an intake-commit seam
case; every replacement is detected before it executes, and the definite committed response-loss retry recovers once.

The exact product is frozen at `b86e60e5f8389029030deaaada890267e5f92f53`. The zero-repair independent review
packet is `docs/reviews/CR13A_LIVE_050_PROVIDER_DISABLED_INGRESS_REVIEW_PACKET.md`, SHA-256
`8836319fe7d396a73d93192db10a0bf97eece09e4d85b463a32470a67063ac8c`. The preserved independent report rejected this
target because post-import mutation of canonicalization operations could execute and make a drifted final receipt pass
its digest check. The rejected report SHA-256 is
`ae40c366c16ac9d72cdc0be6db0393fd02904eef77b07b3e04bd8a07b7c6b255`. Remediation and a different independent
re-review are required before integration.

## M-001 remediation candidate

The ingress module now captures the complete canonicalization/hash selection it depends on: global constructor/object
identity, property inspection, object keys/freezing, array classification/mapping/sorting/joining, numeric checks, JSON
encoding, chronology, string slicing, regex execution, reflection, typed-array cleanup, and native hash update/digest.
It verifies those exact selections plus a canonical digest sentinel before direct receipt parsing and public composition.

The coordinator re-establishes that boundary at receive entry, immediately after each awaited delivery, protected read,
and intake seam, and again before final receipt construction. Final reference slicing uses its captured operation. A
change during the successful intake transaction therefore closes with `integrity_failed` before the replacement runs;
the already committed result remains recoverable through the existing exact replay path. Caller-owned key bytes remain
untouched, while the three temporary constructor copies are still wiped with the captured typed-array operation.

This remediation does not alter the wire contract, proof ordering, persistence, receipt fields, runtime default, route
surface, or effect boundary. The rejected report remains authoritative for the superseded exact target. The remediation
must be frozen and reviewed by a different independent reviewer before integration.

## Next boundary

After independent acceptance and owner-approved integration, a later block may define one bounded transport admission
contract or owner-attended enrolled-connector rehearsal packet. That work must stop before an actual listener, machine
connection, SSH/Hermes/native action, credential use, provider call, production PostgreSQL/VPS contact, or deployment
unless separately authorized against a new exact packet.
