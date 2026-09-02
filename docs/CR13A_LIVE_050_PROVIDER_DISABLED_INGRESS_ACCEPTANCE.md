# CR13A-LIVE-050 provider-disabled enrollment ingress acceptance

**Status:** verified implementation candidate; exact freeze and independent review required
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
- `tests/connection-enrollment-node-ingress.test.ts`: 7/7 pass
- complete connection slice: 35/35 pass
- complete repository lifecycle: 769/769 pretests, 419/421 core tests with two intentional platform skips, and 286/286
  posttests
- migrations `0001` through `0036`: pass, 119 PostgreSQL tables
- production build: pass, 4/4 rendered routes
- exact whitespace gate: pass

The focused suite covers end-to-end enrollment, exact response-loss replay, outer/inner signature separation, routing-hint
binding, invalid hint before replay, intake failure and later recovery, concurrent exact retries, distinct HMAC key
domains, behavioral input/database rejection, disabled default, receipt drift, protected-value absence, and absence of
an app route/listener/port.

An exact product freeze and independent zero-repair review remain required before integration.

## Next boundary

After independent acceptance and owner-approved integration, a later block may define one bounded transport admission
contract or owner-attended enrolled-connector rehearsal packet. That work must stop before an actual listener, machine
connection, SSH/Hermes/native action, credential use, provider call, production PostgreSQL/VPS contact, or deployment
unless separately authorized against a new exact packet.
