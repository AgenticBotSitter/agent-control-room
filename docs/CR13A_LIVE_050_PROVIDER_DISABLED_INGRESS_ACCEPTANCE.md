# CR13A-LIVE-050 provider-disabled enrollment ingress acceptance

**Status:** second remediation `bbd3bcbd659ab91461bb52117718a95098c7bb80` independently rejected with one Low allowlist defect; narrow third remediation required
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
- `tests/connection-enrollment-node-ingress.test.ts`: 11/11 pass
- complete connection slice: 39/39 pass
- complete repository lifecycle: 769/769 pretests, 419/421 core tests with two intentional platform skips, and 290/290
  posttests
- migrations `0001` through `0036`: pass, 119 PostgreSQL tables
- production build: pass, 4/4 rendered routes
- exact whitespace gate: pass

The focused suite covers end-to-end enrollment, exact response-loss replay, outer/inner signature separation, routing-hint
binding, invalid hint before replay, intake failure and later recovery, concurrent exact retries, distinct HMAC key
domains, behavioral input/database rejection, disabled default, receipt drift, protected-value absence, and absence of
an app route/listener/port. Remediation adds a 20-operation post-import replacement matrix and an intake-commit seam
case; every replacement is detected before it executes, and the definite committed response-loss retry recovers once.
The second remediation adds direct and unusual-prototype rejected-value cases. Both return a newly constructed bounded
error without consulting the rejected value's behavior, and both prove zero delivery, intake, or registry persistence.

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

The exact remediation is frozen at `7c79837cb60e497a7f49a203f20382afe133bd91`. Its zero-repair closure packet is
`docs/reviews/CR13A_LIVE_050_REMEDIATION_REREVIEW_PACKET.md`, SHA-256
`5ed0af3e0552fbd4722211bf035b6bc705c50624ccca3c45445c0906b11bd1a9`.

The different reviewer closed M-001 but rejected the exact remediation because caught Proxy rejection values reached
unguarded `instanceof` checks in node-delivery and ingress, executed behavior, and escaped raw. The preserved re-review
SHA-256 is `67b8eaeffd6bbcc86eb81d061107beaf464b5dcb0f680317ad3d18cb89c85992`; it requires behavior-free error
classification and zero persistence before another different review.

## M-002 remediation candidate

Caught unknown values are no longer classified with `instanceof` anywhere in the connection-registry store, enrollment
intake, node-delivery adapter, or ingress coordinator. The shared classifier first rejects a direct Proxy through Node's
host predicate, requires the exact immediate error prototype, and reads only an own string data descriptor. It does not
walk a caller-controlled prototype chain or invoke a getter.

Each boundary now constructs a fresh local error from an explicitly allowed code. Any other rejection becomes the
boundary's bounded integrity or source-unavailable result; the raw rejected value cannot cross the public ingress
boundary. Genuine local errors retain their documented mapping.

Two database-rejection regressions cover both a direct self-throwing Proxy and an ordinary object whose immediate
prototype is a behavior-bearing Proxy and whose `safeCode` is an accessor. Each case records zero behavior execution,
returns a fresh `ConnectionEnrollmentNodeIngressErrorV1("integrity_failed")`, and proves that delivery, intake, and
registry tables remain empty. The fixture's one preexisting node-enrollment replay row remains unchanged and does not
grant enrollment authority.

The exact second remediation is frozen at `bbd3bcbd659ab91461bb52117718a95098c7bb80`. It does not alter the wire contract,
proof ordering, HMAC domains, receipt shape, disabled default, route surface, or effect boundary. Another reviewer,
different from the producer and both completed prior reviewers, must accept this exact target before integration.
The zero-repair packet is `docs/reviews/CR13A_LIVE_050_ERROR_CONTAINMENT_REVIEW_PACKET.md`, SHA-256
`f60a27488b7751a3630c16e31704a326445809acfdd2398c263ed8e0c7fbbfeb`.

The different reviewer closed M-001 and M-002's behavior-execution and raw-escape defect, but rejected the exact target
with Low L-001. The node-delivery authentication catch accepted any own string `ProtocolAuthenticationError.code`
instead of the declared seven-code allowlist, so an unknown downstream value could be mislabeled as an authentication
failure rather than conservative integrity failure. The value remained bounded, ran no behavior, escaped no raw data,
created no persistent record, and granted no authority. The preserved rejected report SHA-256 is
`61c934aca63942f043b613e5137b1ba2824f5f2139534031ba62ad65e732a86b`.

## Next boundary

After independent acceptance and owner-approved integration, a later block may define one bounded transport admission
contract or owner-attended enrolled-connector rehearsal packet. That work must stop before an actual listener, machine
connection, SSH/Hermes/native action, credential use, provider call, production PostgreSQL/VPS contact, or deployment
unless separately authorized against a new exact packet.
