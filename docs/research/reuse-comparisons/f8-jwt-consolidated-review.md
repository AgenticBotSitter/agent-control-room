# F8 consolidated JWT independent source review

2026-09-08; checkpoint `f2bac29`, current research additions. Reviewed both consolidated
harnesses, report and structured/direct evidence, current verifier/project HTTP source,
prior acquisition file guards and retained selected package verification implementations.
No candidate rerun, download, application edit, credential, server or native operation.

## Disposition

No blocking defect found for the stated bounded comparison. This is meaningfully wider
than substituting a signature call: actual library header decoding and verified payload
parsing now replace the custom JSON parsing and signature block, while current CR
policy still evaluates the returned claims. It is not final adoption or all-caller proof.

### Fidelity and trust boundary

- Both transformations assert the current verifier hash and remove the actual `decode`
  implementation plus direct RSA verification block. Source-position checks and absence
  assertions guard the intended transformation. The HTTP harness additionally hashes
  actual `project-http`/`http-common`; its module cache shares the exported error class,
  preserving `instanceof` behavior. VM evaluation is code execution, not a sandbox.
- Unverified header decoding is used only after canonical byte checks, through the strict
  header schema and deployment-captured key map. It selects a local trusted key; no
  request-supplied key URL is followed. Identity uses `jwt.verify`'s returned payload or
  awaited `jose.jwtVerify(...).payload`, not the preliminary decode's unverified payload.
  Retained package source confirms signature verification precedes successful payload
  return/claims validation. Both constrain RS256 and issuer/audience.
- Canonical Base64url/fatal UTF-8 checks, strict header policy, app token type, bounded
  array audience, subject/time schemas, safe integer checks, captured trust and frozen
  six-field identity remain. Keeping those is disclosed; this does not remove all JWT
  framing or application identity policy.
- `requiredClaims`/`maxTokenAge` for jose and `maxAge` for jsonwebtoken are real configured
  options. The latter uses equivalent seconds expressed as a suffixed string in policy
  harness and numeric seconds in HTTP harness. Narrative wording “strong applicable”
  is appropriate, not evidence that every option or all possible policy combinations
  were evaluated. Minimal-option baseline accepts are not library vulnerabilities.

### Executed evidence and limits

Parsed direct receipt stdout contains 99 policy results (33 per variant) and 50 HTTP
results, both exit 0. The earlier truncated run is separate. The policy checks compare
expected accept/reject outcomes, error code for ordinary denials, all six successful
identity fields against current code and frozen output. Expired-trust/invalid-clock
policy rows check rejection only; HTTP coverage separately checks their 401 responses.

Actual HTTP modules are invoked as functions against a synthetic `listPage` service,
not sockets or PostgreSQL permissions. Positive identity assertions, no-store checks,
denial call deltas and captured-key rotation are substantive. The intentionally missing
await demonstrates a Promise crossing that seam (one synthetic service invocation/503),
not a real authorization bypass. Held invalid verification proves eventual denial and
zero calls; it is not valid-token expiry-during-verification coverage.

The remaining freshness gate is important and explicitly open: both adapters retain
the pre-verification `nowMs`, and merely adding `await` does not resample time. Before
jose adoption, hold a valid verification across token/trust expiry using a controlled
clock, then exercise the actual downstream authority boundary and prove denial before
effects. Also preserve synchronous factory rejection of invalid trust. Other inventoried
callers need real mapped tests, not an assumption that project-handler success covers them.

Selected package files are hashed before candidate import; frozen package-integrity
installation is reported separately. This is not an exact-file guard on every installed
dependency or a new transitive license audit. Prior MIT/BSD/Apache/ISC obligations remain.
Cleanup is pending author action at review time; no independent cleanup observation.

## Decision and removal scope

The report fairly preserves all three strong alternatives: platform crypto/current
policy, synchronous jsonwebtoken (15-package closure including itself), and zero-runtime-
dependency jose with async migration. Actual library reuse now covers a coherent parsing
and verification responsibility, but custom canonical validation and policy remain.
No whole auth subsystem, store or identity grant mechanism is removable from this evidence.
Production deletion stays zero and timing/RSS are correctly not a comparative benchmark.

Next decisive local work is the promised all-caller adaptation/freshness and exact
maintenance/deletion-cost comparison, not a new generic auth engine. Final security
selection remains the architect's responsibility; the current source-and-seam comparison
is acceptable to retain as evidence toward that decision.

## Downstream authority extension review

Source-only follow-up checked four new cases and parsed the separately retained
`downstreamAuthorityExtension` direct receipt: exit 0, 54 results, earlier 50 retained.
Actual `WebSessionAuthority.authenticated` clones the verified identity, samples its
own clock and calls `assertFresh` before entering `transactionWithPreCommitCheck`.
The harness passes actual consolidated jose output verified at the captured initial
time, with a later logical clock at authority entry. Trust expiry, token expiry and
session-age expiry each reject with `authentication_required`, zero transactions and
zero operations. The fresh control reaches the fail-on-entry transaction sentinel
exactly once, so this is not an always-rejecting fixture. No production policy changed.

This closes the narrow direct-composition freshness-preflight evidence gap. It does
not close all-caller migration: verification is released immediately and logical time
is advanced in the downstream clock, not elapsed wall time; HTTP-to-real-service
wiring, owner bootstrap, database grants and precommit behavior are not executed by
these four cases. Report correctly discloses those limits. The authority is imported
directly from current checkout rather than added to `sourceHashes`; that array still
describes the three transformed modules only. No exact hash pin is claimed here for
the newly imported authority or its transitive imports.

No additional blocking finding. Final package choice and whole-caller acceptance
remain open; retained package source is no longer required by this reviewer.
