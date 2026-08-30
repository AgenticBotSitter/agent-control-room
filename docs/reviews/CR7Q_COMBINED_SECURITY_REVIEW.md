# CR-7Q combined harness, MCP, SDK, and package-registry security review

**Date:** 2026-08-28
**Mode:** Codex architect adversarial review, independent review, architect remediation, and accepted different independent re-review
**Scope:** CR-7A through CR-7E repository implementation
**Effects:** None. No native harness, provider, credential, network listener, issuer, service, or production project was touched.

## Current disposition

The architect review found and remediated eleven concrete repository weaknesses. The first independent combined review then found eight additional high-severity weaknesses. All eight were remediated with focused regressions. A different independent reviewer reproduced and accepted the repairs, found no new evidence-backed repository defect, and recorded `accepted_with_explicit_native_and_deployment_blockers` in `CR7Q_INDEPENDENT_REREVIEW.md`. CR-7Q is complete for this stable effect-free repository snapshot; every listed native and deployment blocker remains in force.

| Surface | Repository disposition | Native or deployment disposition |
|---|---|---|
| Hermes adapter | Accepted only for pinned, disposable, zero-callable-tool observation and the already captured owner-attended lifecycle evidence | Effect-capable/native use disabled; approval response remains unqualified |
| Codex adapter | Repository security contracts accepted with prior independent CR-7B reviews | Native execution disabled by the documented OS-isolation and credential blockers |
| Northbound MCP | Effect-free proposal/read implementation accepted after remediation | Network transport, issuer, TLS, revocation, and canonical proposal materialization disabled |
| Public adapter SDK | Accepted as an exact observation-only interface | No execution, approval, credential, dispatch, or effect API exists |
| Procedure/knowledge registry | Effect-free repository implementation accepted after remediation | Protected service/API deployment disabled; package selection never grants execution authority |
| Combined CR-7 gate | Accepted after architect remediation and different independent re-review | Effect-free CR-7 integration exit open; native and deployment gates remain closed |

## Finding matrix

| ID | Severity | Finding | Remediation and proof |
|---|---|---|---|
| CR7Q-F01 | High | Harness event history allowed direct update/delete and read paths trusted stored JSON | Added database update/delete/truncate guards, run digests, event digest verification, normalized-column checks, and event-sequence reconciliation; tamper tests fail closed |
| CR7Q-F02 | High | Registry package, review, mapping, and promotion reads did not recompute their stored digests | Every read and activation path now strictly parses and recomputes the relevant digest before use |
| CR7Q-F03 | High | The mutable active-package pointer could be changed to an older valid package without appending a rollback | Channels now bind the exact newest promotion ID, digest, and channel revision; resolution and activation reject pointer/history divergence |
| CR7Q-F04 | High | Public adapter conformance could accept an adapter that exposed hidden effect methods | Runtime conformance now requires exactly four public keys: SDK version, manifest, compatibility evaluator, and event normalizer |
| CR7Q-F05 | High | Adapter conformance did not bind normalized time and sequence exactly to the supplied context or prevent duplicate source-event keys | Exact timestamp, consecutive sequence, run binding, source, and source-event uniqueness are now required |
| CR7Q-F06 | High | MCP could finish a slow read after its signed access grant expired and return the protected result | The grant is rechecked immediately before execution and again before replay settlement or response release |
| CR7Q-F07 | High | Recomputed MCP SQLite rows could contain expanded proposal shapes or secret-bearing replay results | Durable proposal rows now pass the strict discriminated schema; replay results pass exact shape, canonical text, safe-projection, and secret checks |
| CR7Q-F08 | Medium | MCP proposal decisions did not revalidate the stored proposal or decision chronology | Decision now verifies the immutable proposal row and rejects a decision timestamp before the request |
| CR7Q-F09 | Medium | Arbitrary JSON-RPC string IDs could be oversized or secret-bearing and then echoed | String IDs now use the bounded safe-ID schema; malformed IDs return a null-ID protocol error |
| CR7Q-F10 | Medium | A previously active package could be reactivated as a `promote`, hiding rollback semantics; redundant activation was also allowed | Previously active targets require `rollback`, never-active targets require `promote`, and activating the already active digest fails |
| CR7Q-F11 | Medium | Registry lifecycle timestamps could precede package creation or regress behind review/mapping/channel history | Review, mapping, activation, and channel chronology now fail closed |

## Independent-review remediation matrix

The immutable first-review report is `CR7Q_INDEPENDENT_REVIEW.md`. Its eight findings are repaired as follows; this table records producer claims for the next reviewer to attack, not an acceptance verdict.

| ID | Severity | Repair | Regression evidence |
|---|---:|---|---|
| CR7Q-IR-F01 | High | Harness run and event rows now carry externally keyed HMAC tags over every normalized security column and payload digest; every read reconciles an authenticated, complete, consecutive event history | Recomputed normalized-row changes, inserted gaps, and incomplete history fail closed |
| CR7Q-IR-F02 | High | The durable Codex broker requires an external integrity key, authenticates its complete security state, strictly reparses permits and exact limit objects on open/use, and binds the permit digest and endpoint | Recomputed permit expiry, call-budget, model, and I/O-limit widening fail before claim or dispatch |
| CR7Q-IR-F03 | High | Adapter construction now snapshots exact own data descriptors on a plain object and deep-freezes the adapter, manifest, decisions, and normalized outputs; symbols, accessors, non-enumerable members, writable/configurable members, prototypes, and proxy-visible widening fail | Prototype, descriptor, accessor, symbol, mutation, and hidden-effect regressions fail conformance |
| CR7Q-IR-F04 | High | MCP rechecks the current signed grant and validates the selected tool's exact scoped output immediately before returning a replay | A replay crossing expiry is denied without releasing stored protected content |
| CR7Q-IR-F05 | High | Proposal recording is a synchronous serialized commit boundary, and the server performs a fresh trusted-time grant check after the last awaited dependency and immediately before recording | Expiry during authority resolution produces no durable proposal |
| CR7Q-IR-F06 | High | Durable replay rows authenticate exact tool, tenant, project-scope, grant-body, request, and tool-specific result bindings; proposal rows authenticate and reconcile every normalized selector, body, receipt, decision, and chronology field with an external key | Recomputed safe-looking replay substitution and strict proposal expansion fail on reopen/read |
| CR7Q-IR-F07 | High | A verified mapping's verbs must exactly equal the package declaration and each verb must exist in the adapter manifest; the exact strict manifest and its digest are stored inside the authenticated mapping | Missing, extra, undeclared, unsupported, and manifest-drift mappings fail compatibility or replay |
| CR7Q-IR-F08 | High | Registry package, review, mapping, promotion, and channel rows carry external HMAC tags; resolution reconstructs every consecutive promotion, prior link, action semantic, timestamp, review, mapping, package, and active pointer | Recomputed rows, forged inserted promotions, pointer rewind, and incomplete history fail closed |

## Cross-boundary conclusions

1. A normalized harness observation is evidence, not a lease, approval, or authority envelope.
2. An MCP request may read scoped projections or record a proposal. It cannot create canonical work, approve, lease, reserve, dispatch, issue credentials, or perform effects.
3. A passing SDK fixture proves only exact safe normalization for the pinned manifest. Hidden methods and lineage drift fail conformance.
4. A reviewed procedure or knowledge package supplies instructions or facts only. Compatibility states that instructions can be delivered through an exact adapter mapping; it never states that execution is allowed.
5. Package activation is review-gated configuration state, not operational authority. Scheduling, policy, leases, node-local admission, authority envelopes, and effect approval remain separate gates.
6. Raw native session/thread identifiers, credentials, paths, transcripts, output, and private broker state do not cross the public SDK, MCP, or registry projection boundaries.

## Residual blockers retained

- The CR-7B native Codex blockers in `CR7B_ACCEPTANCE.md` remain unchanged and keep native execution disabled.
- Hermes effect-capable toolsets and approval response remain disabled; only the exact pinned zero-callable-tool disposable evidence is accepted.
- MCP has no deployed transport or production issuer. OAuth/resource metadata, TLS termination, revocation/rotation, service identity, durable trusted-clock operation, and materialization into canonical requests/jobs require later review.
- The registry has no deployed protected mutation API. Any future API must authenticate actors and preserve exact tenant, review, compatibility, optimistic-concurrency, policy, and authority separation.
- The different independent re-review accepted the stable repaired snapshot. Reopen CR-7Q if reviewed security code, migrations, contracts, tests, integrity-key boundaries, manifests, or deployment assumptions change.

## Focused gate

`npm run test:cr7q` runs the harness lifecycle/store, Codex isolated runtime, MCP, public SDK, registry, and registry UI suites together. Both the producer and different independent reviewer passed 120/120 focused tests. The independent complete repository run reports 416 tests: 414 passed, zero failed, and two intentional Windows-only platform skips. Type checking, lint, production build, two rendered-route tests, migration verification through `0021` and 73 PostgreSQL tables, and `git diff --check` pass.
