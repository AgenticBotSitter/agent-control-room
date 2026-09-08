# JWT implementation selection — DR-05

Source baseline `ab1b983`; independently challenged and accepted by root for this
narrow selection, subject to the implementation/shipping gates below. Scope: the current Node22
private web server's pinned-key RS256 token verification, not login-provider choice,
authorization, key discovery, owner consent or an edge-runtime port.

## Decision

**Adapt jsonwebtoken9.0.3 behind the existing synchronous verifier interface.**
It replaces standard JWT decoding/signature/claim implementation without introducing
new await boundaries in six identity-consuming files. Keep Cloudflare Access and
the existing canonical-byte, deployment-trust, schema and session/grant policy.
Do not implement the experimental async bootstrap adaptation just to choose a library.

This supersedes the initial jose preference in `f8-jwt-fit.md`.
That early preference preceded actual bootstrap/dispatch/cache/rehearsal
testing. jose6.2.12 remains a viable, well-tested alternative, not rejected as unsafe.
Its smaller dependency closure is a genuine advantage; its asynchronous API requires
more caller/freshness work for this particular existing server. Keeping Node crypto
also works, but leaves standard JWT processing maintenance with this project rather
than the maintained library. This is not a claim that Node's RSA implementation is
custom or defective.

## Common evidence and surviving alternatives

- Actual consolidated adapters:99 policy cases,50 projectHTTP cases and four
  downstream authority freshness cases. Both preserve the complete frozen identity.
- Actual candidate bootstrap: jsonwebtoken30 and jose23 applicable cases; separate
  sync-only controls explain the count difference, not a success-rate advantage.
- Actual task/news/private dispatch:36 selected cases including held verification.
- Actual cache/rehearsal:23 per candidate,46 total, with reviewed source/sentinels.
- Current-verifier research controls demonstrate missing awaited precommit,
  post-await expiry/cancellation and intermediate clock high-water problems in
  deliberately incomplete async adaptations. They identify migration work, not
  vulnerabilities in jose or the current synchronous application.

Evidence: [consolidated](f8-jwt-consolidated-fit.md),
[callers](f8-actual-callers-fit.md), [preflight](f8-actual-preflight-fit.md),
[clock boundaries](f8-cache-rehearsal-boundaries.md),
[caller inventory](f8-jwt-caller-audit.md).

Pass/fail gates: both candidate roots have inspected MIT licenses; recorded resolved
dependencies use permissive license metadata, with shipping-text closure still
required in RC10. Both supply the required Node22 pinned-key capability and pass
the listed local policy cases with CR adapters. Neither requires a service, DB
migration, remote key URL, changed login provider or upstream fork. Retain-current
passes compatibility but is not preferred on standard-token maintenance grounds.
No deployment or complete distribution acceptance is claimed.

## Published rubric and uncertainty

Scores are explicit engineering judgments on0–5, not measurements. Higher effort
score means less integration/maintenance work. The program's weights apply; unknown
resource performance remains the full0–5 interval, not an assumed zero. Maintenance
uses ranges because release history and dependency counts do not establish future
support. This sensitivity table does not mathematically prove a winner.

| Option | Fit30% | Integration25% | Custom standard-token work avoided20% | Maintenance15% | Resources10% | Weighted interval |
| --- | --- | --- | --- | --- | --- | --- |
| Current Node policy/crypto | 5 | 5 | 1 | 2–3 | unknown0–5 | 3.25–3.90 |
| jsonwebtoken + narrow adapter | 5 | 4 | 4 | 3–4 | unknown0–5 | 3.75–4.40 |
| jose + complete async adapter | 4 | 2–3 | 4 | 4–5 | unknown0–5 | 3.10–4.00 |

Fit difference reflects demonstrated caller-contract mismatch before adaptation,
not cryptographic quality. Integration: one production verifier module versus that
module plus six consuming files and awaited precommit/high-water regression work.
Both libraries take over the same narrow standard JWT responsibility; neither
removes most application policy. Maintenance favors jose's zero runtime dependency
closure and explicit current-major support; jsonwebtoken has14 transitive packages.
Current has no new packages but keeps token processing/update responsibility here.
Source and dependency costs are observed; development hours and runtime performance
are not. The intervals overlap: selection is the explicit judgment that minimizing
this migration while still borrowing token verification outweighs the extra small
dependency graph for the current Node-only deployment. Reopen if that premise changes.

The combined temporary16-package installation used about1.3MiB including its cache,
not per-library resident memory. Prior mixed-process timings/RSS do not establish
latency/throughput or a smaller production server. Required release load checks remain.

## Exact adaptation and non-deletion boundary

Production target: `src/web/v1/access-verifier.ts`, `package.json`, `pnpm-lock.yaml`
and generated release-attribution inputs/output. Use ordinary package import, not
the research VM/source substitution. Target module's existing `decode` loses its
JSON.parse responsibility; keep canonical-base64url/fatalUTF8 validation as required
by the mapped policy. Use library-decoded header only to select from the trusted key
map, then library-verified payload through the existing schemas. Configure RS256,
issuer, audience, captured clock, zero tolerance and maxAge explicitly.

Remove direct signature decoding/Node verify call inside token verification and its
unused import. Keep `createPublicKey`, trusted key validation, key cardinality/size,
strict header/type/claim rules, current expiry/session semantics, digest and frozen
six-field output. Keep same-origin functions. No whole file/subsystem deletion;
production lines deleted now0, eventual exact diff determined during integration.

TypeScript integration is not established by the VM's JavaScript execution. Check
published typings/CommonJS interop under this repository's bundler module resolution;
if separate maintained typings are required, pin and inventory that build-time
dependency too. It is not included in the observed15-package runtime closure or the
1.3MiB research cohort. Do not use an unchecked `any` declaration to manufacture a
passing typecheck. This remaining build check can reopen the effort comparison if it
reveals a substantive mismatch rather than an ordinary type-package addition.

Caller signature edits:0. Regression targets remain all eight factory sites across
project-http, task-http, news-collection-http, private-process, private-owner-bootstrap
(two sites), private-database-rehearsal and access-key-cache. Preserve existing
post-body/key-load/session freshness and cancellation checks. Selecting sync does not
erase those existing asynchronous operations or qualify their whole application.

No DB backfill or identity/session rekeying. Rollback restores the previous verifier
and package lock only after parity checks confirm identity/token-digest semantics
unchanged. Never loosen validation, accept unknown keys or introduce a login bypass
as rollback. Pause rollout if a mismatch could affect existing session identity.

## Upstream implementation/test review

In addition to executed published modules, root read actual pinned
[jsonwebtoken verify tests](https://github.com/auth0/node-jsonwebtoken/blob/ed59e76ea37a80f54b833668c02a5271984dcba3/test/verify.tests.js):
RSA verification, unsigned-token policy, callback-key error ordering, clockTimestamp,
expiration/maxAge interaction and key-type refusal. These tests were read, not run.

Root also read the complete18,198-byte
[jose JWT verification tests](https://github.com/panva/jose/blob/v6.2.12/test/jwt/verify.test.ts),
Git blob `d0f10ec122071f3dc4f30679a5a510f172987c4b`: claims/payload checks,
signature-before-claims ordering, required claims, finite time options and invalid
UTF8. This is not its entire suite or a new RSA execution test; much of that file
uses HMAC. Tests were read, not run. Earlier web-cache fetch failures were overcome
with read-only public API/raw-source reads; no source files retained on disk or run.

[Maintenance refresh](f8-jwt-maintenance-refresh.md) preserves the distinct release
and support signals. Package archive integrity/source hashes and root-license reads
remain in existing acquisition ledgers. New dependencies require complete attribution
and advisory review at actual integration; research does not claim legal clearance.

## Required implementation acceptance and reopening

Integrate in the approved implementation phase; do not repeat unchanged
research experiments for ceremony. Run repository preparation, typecheck/lint and
focused verifier/cache/origin/session/bootstrap/rehearsal tests against the actual
import, including full identity parity and denial-before-service cases. Then build
the private release and verify its attribution/runtime imports and bounded load.
Owner MFA/subject/origin acceptance remains A2's independent live gate.

Reopen for Node/runtime relocation, a required unsupported algorithm/interface,
material maintenance/security change, measured dependency/load problem or an approved
broader async migration that removes the current caller-cost disadvantage. Do not
install both token libraries in production to preserve optionality.

## Independent challenge and confidence

[Independent review](f8-jwt-selection-review.md) found no blocking objection to this
narrow selection, with typing, attribution and release gates retained. Its P3
confidence-label request is addressed here: **moderate overall confidence**, high
confidence in the observed synchronous caller-shape advantage, lower confidence in
future maintenance and unmeasured comparative runtime resources. Fit/integration
scores partly share the caller-mismatch evidence and must not be mistaken for two
independent experimental wins. Root accepts the explicit tradeoff, not a statistical
or security ranking. No final A2/live-login or all-RC8 acceptance follows.
