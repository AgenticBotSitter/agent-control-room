# Independent F8 JWT fit review

2026-09-08. Read-only review of retained harness, report, receipts, actual Control Room access verifier/project HTTP caller, and retained jose/jsonwebtoken verification implementations under the owned research root. No test execution, downloads, service calls, credentials or application edits by this reviewer.

## Disposition

No blocking fidelity finding for the stated **signature-call substitution experiment**. This is real candidate library execution inside an explicitly adapted copy of current policy, not complete middleware/HTTP acceptance and not meaningful authentication-system replacement. Provisional jose preference is acceptable only with the report's stated next-handler gate; jsonwebtoken's synchronous route and retaining Node crypto remain viable alternatives.

## Narrow corrections

1. **P3 — license summary omits ISC.** The report lists MIT, BSD-3-Clause and Apache-2.0 metadata for jsonwebtoken's dependency resolution, but `f8-jwt-acquisitions.json` also records `semver@7.8.5` as ISC. Add ISC to that summary. This does not establish a licensing incompatibility; complete distribution notices remain a separate review.
2. **P3 — acquisition ledger still says the run is pending.** The markdown acquisition ledger ends with `Acquisition/run/cleanup: pending` and says not to treat the entry as successful, whereas the fit report and direct receipt now show completed runs. Update the acquisition/run state independently of cleanup (the retained root is intentionally still available for this review). Do not claim cleanup until observed.

## Fidelity and evidence limits

- The current source hash is checked and the signature expression occurs exactly once before replacement. Actual library calls receive the complete token, selected trusted public key, RS256 allowlist, issuer, audience and test clock. jose's returned function is deliberately made asynchronous. The original post-verification schema, timestamps, session cap and output construction remain. The VM is explicitly not advertised as a sandbox.
- These candidates perform payload parsing/claim validation themselves before CR reparses and applies policy. Thus this is more than bare RSA verification, but it proves acceptance parity only for the enumerated cases, not parser equivalence for every possible signed payload. No duplicate-claim, Unicode or all key-rotation/clock boundary equivalence is established.
- The 69 mapped classifications and ten minimal-options observations agree with the harness and receipt. Positive checks assert subject, token digest and expiresAt, but not the complete identity object (provider, issuedAt, verificationExpiresAt and immutability). Trust-expiry and invalid-clock cases assert rejection without checking the exact public error code. The report's proposed full-output/error/handler tests should cover those gaps; present results must not be called full identity-output parity.
- The ten library-only observations fairly demonstrate policy absent from those **minimal options**, not inability to configure required claims or an upstream vulnerability. They do not justify retaining duplicate custom logic where an explicitly configured library can replace it; the next adapter should compare strongest supported options rather than only these defaults.
- Selected implementation-file hashes are checked, not the complete installed executable dependency tree. Root package integrity/version receipts and that limitation are explicit. No full-transitive-tree pre-import integrity guarantee should be inferred. I read the actual retained verification modules but did not independently hash/reexecute them.
- Current `project-http.ts` calls `verifyIdentity` synchronously and immediately passes the result to services. An async jose return cannot be dropped in there without awaiting it and checking no service runs before successful verification. The harness awaits all variants; it does not test this application integration hazard. The report correctly makes async propagation a gate.

## Reuse/removal recommendation

The demonstrated removal is approximately one crypto-verification expression, with unchanged CR policy and some redundant parsing; it is not a whole auth subsystem. Neither candidate replaces deployment-selected trust, key-cache controls, database grants/revocation, same-origin checks or owner bootstrap. No production code deletion is justified by this experiment alone.

Keep the next experiment bounded: actual project HTTP handling with both finalists, synthetic service counters, complete output/error checks and explicit async denial ordering; then measure exact caller changes and decide whether a consolidated jose adapter actually reduces maintenance. Include jsonwebtoken configured to enforce the strongest relevant claims and the existing Node-crypto baseline. Timing/RSS figures here are diagnostic only and do not establish a faster or smaller production winner. Cloudflare Access remains the identity boundary; no new login provider is selected.

## Focused disposition after corrections

2026-09-08, source/record recheck only. **Both P3 findings are addressed.** The fit report now includes ISC (semver) in the dependency-license metadata summary. The acquisition ledger records completed install/runs separately from cleanup and now records root-observed exact-directory removal and absence verification, with zero retained cohort bytes. The pending-state finding applies to the earlier snapshot read during review, not this corrected ledger.

I did not independently execute the cleanup or observe the removal command; cleanup is attributed to root's recorded observation. No rerun or effects were performed for this recheck. Original module/HTTP/output-parity limitations and the conditional—not final—candidate recommendation remain unchanged. No blocking finding for the stated bounded fit remains.
