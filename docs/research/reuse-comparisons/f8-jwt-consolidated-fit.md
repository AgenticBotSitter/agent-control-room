# Consolidated JWT library-to-policy and HTTP comparison

2026-09-08; source checkpoint f2bac29. No application edits or live authentication.

## What changed in this comparison

Earlier fixtures substituted only the signature call. This experiment replaces
custom JWT JSON parsing **and** signature verification in an in-memory copy of the
actual verifier with real jose6.2.12 or jsonwebtoken9.0.3 APIs. Library-decoded header
and verified payload flow into the unchanged CR schemas. Selected key trust,
canonical Base64url/fatal UTF-8 checks, exact app/audience/subject/session policy,
frozen six-field identity and token digest remain application responsibilities.
Strong applicable claim options are configured (jose requiredClaims/maxTokenAge;
jsonwebtoken maxAge, and issuer/audience/RS256/time for both). This is not a claim
that every available option is configured or that library defaults are unsafe.

Results:99 policy cases (33 each, including invalid UTF-8, noncanonical padding,
audience limits, null claims, fractional/unsafe expiry and exact nbf boundary) match
current behavior. Successful results match all six identity fields and are frozen.
Fifty actual project-http/http-common checks also pass with the consolidated adapter:
401/403/no-service-on-denial, captured key rotation, no-store responses and full identity.
The deliberate unadapted jose caller reaches a synthetic service with a Promise and
gets503; the correctly awaited caller does not. Held invalid verification never calls
the service. These are research adapters and a synthetic listPage service, not DB
identity grants, a running HTTP listener, whole-app or live Access qualification.

Reproduction and direct evidence:
[policy harness](../../../research/reuse-comparisons/f8-jwt-consolidated-fit.mjs),
[HTTP harness](../../../research/reuse-comparisons/f8-jwt-consolidated-http-fit.mjs),
[receipts](f8-jwt-consolidated-evidence.json).
The initial smaller policy run passed but tool stdout was truncated; the expanded
run's complete output is retained. Original minimally-configured library observations
are still included as labeled baselines, not presented as vulnerabilities.

## Practical adaptation/removal comparison

### Follow-up: downstream freshness after asynchronous verification

Independent review requested a valid-token expiry case. The extended HTTP harness
adds four direct checks through actual `WebSessionAuthority.authenticated`: logical
time advances between verification's captured nowMs and downstream authorization.
Expired trust, token expiry and maximum session age each reject before entering any
transaction or operation. A still-fresh control reaches a synthetic transaction
sentinel exactly once, proving the path is not simply always rejecting. Total54
checks pass; the new receipt is separate from the earlier50-case run.

This uses a real authority class but a fail-on-entry database sentinel, not a database
or grant lookup. Time is simulated, not a measured wall-clock delay. The four calls
are direct verifier→authority compositions; they do not prove every HTTP route or
owner-bootstrap consumer uses that same fresh boundary. Reuse this existing guard,
and still audit those callers before choosing an asynchronous implementation.

| Option | What it changes | What it cannot remove |
|---|---|---|
| Existing Node crypto | No new package; strict parsing plus standard platform RSA verification remains | Existing CR policy and caller contract |
| jsonwebtoken9.0.3 | Library header/payload decode and signature/claim checks, synchronous factory return preserved;15 packages including itself in the recorded closure | Canonical byte validation, schemas, deployment key map, session/grant semantics and output identity |
| jose6.2.12 | Same consolidated responsibility with zero runtime package dependencies; asynchronous verify | Same policy plus required await propagation and freshness handling across all callers |

Removed from the adapted verifier: its `JSON.parse` invocation and direct
`verify("RSA-SHA256",...)`/signature decoding block. Added: library header/verify
wrappers and policy-to-option mapping. The canonical decoder becomes a byte-validation
helper rather than disappearing. No whole auth subsystem or data store can be deleted.
Production deletion:0. No upstream fork, new service or database migration for either.
Exact net shipped code savings are not claimed from the research harness line count.

Current direct caller inventory includes project-http, task-http, news-collection-http,
private-process, private-owner-bootstrap (two construction sites), private-database-
rehearsal and access-key-cache factory validation. The project path is the executed
consolidated HTTP seam; other consumers were located in current source, not all run
through this new adapter. Factory validation must stay synchronous even when returned
verification is async, and owner/session authority must recheck freshness after awaits.

Neither extra dependencies nor a crypto primitive alone determine the choice.
Jsonwebtoken minimizes calling changes; jose minimizes dependency closure; keeping
the current implementation avoids both migrations but retains framing/parsing policy.
The [caller audit](f8-jwt-caller-audit.md) now maps all eight factory sites across
seven files, including repeated owner-bootstrap precommit verification. It identifies
the missing synthetic bootstrap and injected-dispatch experiments; source inspection
does not substitute for executing them.
Before final selection, compare exact remaining caller adaptation/deletion cost and
async freshness against supported synchronous retention. Do not keep a bespoke JWT
implementation merely because it exists; do not replace platform RSA with a larger
dependency graph without a demonstrated maintenance or capability benefit either.

## Resources, licenses and acquisition

Policy batch timings (one process, not a benchmark ranking): current11.27ms,
jsonwebtoken4.60ms, jose9.18ms for33 cases each. Imports/transpilation/key generation
are outside intervals; sequential order/cache differ. Whole-process policy peak
235408KiB and HTTP255392KiB include all variants/tooling, not per-library server use.

Exact package MIT roots and transitive obligations remain in prior F8/F9 dossiers;
no new license clearance is inferred. Recreated a frozen npm lock from the previously
recorded version/integrity/dependency graph; `npm ci --ignore-scripts --no-audit
--no-fund` installed16 packages in the explicit disposable root. Own cache, dev-null
userconfig; no app lock/package modification or scripts. Source and selected package
hash guards from the earlier acquisition receipt remain enforced before execution.
139GiB free before acquisition. After terminal tests and
[independent review](f8-jwt-consolidated-review.md), removed only the1.3MiB owned root
`/private/tmp/cr-f8-jwt.FzikzW`; absence check passed. Exact reconstructed lock/package
identities and cleanup in [ledger](f8-jwt-consolidated-acquisitions.json). No credentials,
provider calls, servers, persistent processes or application dependencies removed.
