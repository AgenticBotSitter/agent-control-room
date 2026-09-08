# F8 JWT actual HTTP-handler comparison

2026-09-08; base a9a9a35. Follows signature-call comparison, does not supersede its limits.

## Result

50 cases passed across current verification, actual jsonwebtoken9.0.3 and jose6.2.12
mapped into actual `project-http.ts` and `http-common.ts`. JSON receipt preserves
the deliberately negative unadapted-jose observation: without await, the service
receives a Promise rather than an identity and the fixture rejects it, yielding503.
That is an adaptation requirement, not a flaw in the currently synchronous product.

With the one explicit await adaptation, held invalid jose verification makes zero
service calls both before release and after401. Every ordinary authentication denial
returns401/authentication_required; same-origin denials return403/access_denied and
no-store headers are retained. Success compares every identity field and requires
frozen identity. Fresh trusted-key snapshots accept new and reject old key; an old
captured verifier rejects the new key (no implicit key refresh claimed).

[Actual receipt](f8-jwt-http-evidence.json),
[original reproduction harness](../../../research/reuse-comparisons/f8-jwt-http-fit.mjs),
[acquisition log](f8-jwt-http-acquisitions.md).

Independent review's missing old-trust denial service-call measurement was corrected;
all50 scenarios passed again with measured/asserted delta. Preserve original receipt;
the stronger [direct recheck](f8-jwt-http-recheck-evidence.json) is separate.

## What is real, adapted and synthetic

Actual source hashes for all three CR modules are checked before execution. A tiny
in-memory CommonJS loader keeps the same error class between verifier and failure
mapping. Actual upstream packages verify genuinely signed in-memory synthetic tokens.
Mapped auth source substitutes the verification call; jose returns an async function
and actual handler awaits it. Other CR policy remains unchanged. Both candidates are
explicitly configured with issuer/audience/RS256/time/max-age; jose also requires
standard mandatory claims. This strengthens the earlier minimal library options.

Only the project-list service is synthetic. It counts invocations, rejects thenables,
records identity and returns an empty list. There is no database/identity-row/grant
verification, project mutation, listener, native client or external request. POST
without origin is a denial case only; it does not exercise successful creation.
VM is not an OS isolation claim. Selection-file hashes plus npm integrity are not
a comprehensive transitive-tree tamper scanner. No product source changed.

50 is16 observations per variant plus held verification and unadapted negative
case. Rotation observation includes both old-key denial and new-key success; count
is named scenarios, not an inflated assertion count. Initial and captured rerun exit0.
Source-hash literal formatting was simplified between runs, with no behavior change.
ESLint passes. Timings/RSS in receipt describe whole test process including all
variants, transpilation and key generation, not production library performance.

## Integration decision and remaining discriminators

Both finalists can fit the tested protected HTTP boundary; neither is rejected.
jsonwebtoken needs no caller async change; jose needs await in this handler, and
equivalent propagation in other callers before adoption. No database migration or
new daemon is needed. Existing tokens, digest keys and identity dates need not change
if the exact same policy/output is preserved; rollback can restore old verifier
implementation without state conversion, subject to compatibility tests.

The tested change still replaces approximately one cryptographic call rather than
removing the custom parsing/claim infrastructure. Therefore it is not enough to pick
jose merely for zero dependencies or jsonwebtoken merely for its synchronous shape.
Next decisive comparison is consolidated parsing/claim adapters, using actual library
payload output and strongest applicable claim options, with strict CR header/canonical
encoding/app/trust policy explicit. Measure code removed rather than retain duplicate
parsing just to make parity easy. Compare against current standard Node crypto call.

Required remaining parity: signed duplicate-field/malformed-Unicode inputs, key
configuration failures, optional timestamp/subsecond boundaries, all factory callers
(especially owner bootstrap and key cache) and expiration while async verification
is pending. The current session-authority checks freshness again, but its actual
transaction path was not executed in this HTTP fixture. These are local comparison
requirements, not new permissions or secretly accepted deployment gates.

The eventual implementation packet should include all factory callers and tests in
one batch, not a single endpoint patch: keep deployment-pinned trust, same-origin,
database grants/revocation and owner presence requirements; remove superseded JWT
decoding only after the consolidated adapter passes parity. Keep Cloudflare provider
unchanged. Live owner/MFA/logout/revocation acceptance remains separately gated.

### Concrete caller migration map

Current source search found eight factory uses outside its definition in seven files:

| Source | jose migration / acceptance |
|---|---|
| `project-http.ts` | Await verified identity before list/create/lifecycle service; list/denial seam demonstrated here |
| `task-http.ts` | Await before task route services; full task route parity still required |
| `news-collection-http.ts` | Await before planning/collection operations; denial must not enqueue |
| `private-process.ts` | Direct nested factory invocation must await identity before protected dispatch |
| `private-owner-bootstrap.ts` (two uses) | Propagate Promise through verifyPinnedOwner and callers; preserve owner-attended input and exact subject checks, no native action in research |
| `private-database-rehearsal.ts` | Await synthetic identity; keep disposable-only DB qualification scope |
| `access-key-cache.ts` | Construction is currently trust validation only; preserve synchronous invalid-trust refusal rather than accidentally making validation lazy |

Update direct verifier consumers in `tests/web-access.test.ts`, foundation/role/
owner tests and shared task/native-result helpers. These are identified edit targets,
not already performed migrations. jsonwebtoken keeps the sync call shape, but still
needs the same policy/parity tests and distribution notices. Source search is a
current inventory, not proof future dynamic callers cannot exist.
