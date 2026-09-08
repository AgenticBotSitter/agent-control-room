# F8 actual JWT library fit

2026-09-08, Control Room source base24f839f. This evaluates token-verification
implementation, not a replacement login provider. Cloudflare Access remains selected.

## Observed result

Actual jose6.2.12 and jsonwebtoken9.0.3 each preserved23 current verifier cases
when wrapped in the existing Control Room policy. Current verifier also passed23:
69 mapped checks total. Ten additional library-only observations show why replacing
the whole verifier with a default JWT call is insufficient: both configured libraries
accepted string audience, missing subject, different application token type, missing
expiration and future issued-at. These are deliberately minimal library options,
not vulnerabilities or proof those libraries cannot enforce stronger options.
Both libraries support additional claim controls; CR-specific policy remains needed.

[Direct execution receipt](f8-jwt-evidence.json), [package identities](f8-jwt-acquisitions.json),
[reproduction](../../../research/reuse-comparisons/f8-jwt-fit.mjs).
All keys/tokens generated in memory, synthetic .invalid identity, no network in tests.
No credential store, browser, actual Access token, database or service launched.

The prototype hash-checks the current actual verifier source and selected candidate
entry files, transpiles a research-only copy, and substitutes the RSA verification
expression with the actual library call. jose additionally changes the returned
function to async. All other current framing/schema/key/trust/output checks remain.
This is an explicit source adaptation at the real verifier boundary, not a shipped
adapter or untouched whole-application test. VM provides a module-loading convenience,
not an OS sandbox. Download integrity is npm's lock integrity; listed source hashes
do not constitute full post-install transitive-tree tamper detection.

## Implementation read, constraints and alternatives

| Option | Actual implementation and fit | Cost / removal |
|---|---|---|
| Current | Node crypto RSA verification, strict canonical framing, Zod claims, synchronous request identity | No dependency; approximately one signature-verification expression is replaced in this prototype, not an entire auth system |
| jsonwebtoken9.0.3 | `verify.js` calls jws verification, checks algorithm/key type, issuer/audience/time; synchronous pinned-key route fits current callers | One direct package plus14 transitive packages in this isolated resolution; Node-oriented; still retain CR policy and key trust |
| jose6.2.12 | `jwt/verify.js` invokes `lib/jws_verify.js` and `jwt_claims_set.js`; WebCrypto RSA and claims; no runtime package dependencies | One package, asynchronous verifier. All callers and bootstrap validation need deliberate async propagation before adoption; no new process/DB |

Current source: `src/web/v1/access-verifier.ts`. Keep bounded request size,
deployment-selected key map, trust expiration, exact app claim/type, maximum session,
canonical encoding policy and stable identity digest. Keep `session-authority.ts`
database identity/grants/revocation; JWT validity is not project or execution authority.
Keep `access-key-cache.ts` controlled discovery/cache policy; neither experiment enables
remote JWKS URLs from headers. Keep same-origin/return-path functions in verifier file.

Async callers include project-http, news-collection-http, private-process and
private-owner-bootstrap; source search identified them but no complete caller migration
ran. jsonwebtoken avoids that propagation. jose removes more dependency maintenance;
neither trial demonstrates meaningful net application-code deletion yet. Keeping the
current Node-crypto call is a real alternative, not automatically inferior simply
because it is custom glue over a standard crypto primitive.

**Provisional preference:** jose for a consolidated standard JWT implementation if
the next full-handler adapter preserves all policy and proves manageable async changes.
Strong alternative: jsonwebtoken for minimal synchronous integration. Retaining current
verification remains viable if measured integration costs outweigh the small removed
surface. Do not choose a winner solely from this signature-call substitution.

## Evidence and measurement limits

Cases cover good token/no optional typ, incorrect signing key, issuer/audience/key ID,
missing subject/expiry, wrong type/algorithm, expired/future/fractional timestamps,
exact maximum-age boundary, overlong/absent/malformed token, padded signature, unknown
header field, expired trust and invalid clock. Public output contains only classifications,
not tokens or keys. Initial run and evidence-capture run both passed.

Single-process sequential run timings (23cases each) are diagnostic, not a throughput
ranking: current10.88ms, jsonwebtoken3.49ms, jose6.44ms. Warmup/order differ; key generation,
imports and transpilation are outside these intervals. Whole-process peak234432KiB
includes TypeScript and all variants, not per-library or production memory. No measured
startup distribution, full HTTP latency, event-loop load or multi-host result yet.

## License, provenance and next decisive block

Both exact root license texts are MIT and were read. jose has zero runtime dependencies;
jsonwebtoken resolution includes MIT, BSD-3-Clause, Apache-2.0 and ISC (semver) metadata. Full package
versions/integrities are retained, but all transitive embedded-file licenses are not
cleared. Shipping requires inclusion in F9 actual distribution inventory/notices.
No upstream files are copied into the product. No fork is needed for either candidate.

Sources: [jose](https://github.com/panva/jose),
[jsonwebtoken9.0.3 verification](https://github.com/auth0/node-jsonwebtoken/blob/v9.0.3/verify.js).
The executed immutable identity is the versioned registry archive/integrity, not a moving
branch. jsonwebtoken registry gitHead ed59e76ea37a80f54b833668c02a5271984dcba3;
jose registry response omitted gitHead. Upstream expiry test page was located;
full pinned upstream test-suite inspection/execution remains incomplete (two browser
fetches failed). Do not substitute README assertions for that remaining evidence.

Next bounded block: extract an explicit shared policy adapter with real package parsing
and verification, map both finalists through actual project HTTP handling (synthetic
service only), compare missing/expired identity and no-service-call-on-denial, verify
full identity output and trust/key rotation parity, inspect pinned upstream tests,
and independently review strongest alternative and exact async call-site/removal map.
Retain ordinary auth tests and add mapped cases; no deployment or login change.
