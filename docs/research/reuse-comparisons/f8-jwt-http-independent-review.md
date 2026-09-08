# Independent F8 JWT HTTP-handler fit review

2026-09-08. Source/receipt review of the retained experiment and the actual three Control Room modules. No independent rerun, downloads, services, credentials or application edits. This does not select the final JWT implementation or complete F8.

## Finding

**P3 — one rotation receipt's zero-call value is not measured.** In the `old captured trust rejects new key` scenario, the harness asserts401 but writes `serviceCalls:0` as a literal without capturing the before/after counter. Add a counter-delta assertion and record that delta for this scenario. The current handler source correctly verifies before invoking the service, and surrounding denial cases do measure counters; this is a narrow evidence assertion gap, not evidence an unauthorized call occurred.

## Fidelity and scope

- All three current module source hashes are checked. Replacement matches exactly once; jose changes the verifier to async and the actual handler's identity expression to await. The loader cache shares the actual `WebAccessError` constructor between auth, project-http and http-common. Therefore401/403 mapping is not accidentally relying on unrelated exception classes from separate module evaluations.
- Actual candidate packages perform RSA/JWT verification against synthetic signed tokens. Existing policy still parses the token after candidate verification. This is an explicitly adapted real HTTP handler, not a substituted handler and not a consolidated parser replacement. VM and selected-file integrity are accurately limited.
- Ordinary success checks compare all six identity fields and require frozen identity. Most denials assert exact error bodies and no calls; same-origin denials run before verification. The report correctly separates the real Request/Response/auth/error pipeline from the **synthetic `listPage` service**, which has no database grants, sessions, revocation or transaction behavior. No successful mutation route is exercised.
- The async negative control is meaningful: without the await adaptation the service sees a thenable, deliberately rejects it and yields503. That is fixture-observed adaptation failure, not an existing synchronous-product bug or a claim a real service necessarily responds identically.
- The held jose call exercises a pending candidate followed by invalid-signature denial with no service invocation. It does not advance the clock across expiration or exercise a real session-authority freshness check. A zero-delay event-loop yield is used, not a recorded positive gate-entry acknowledgement; given the retained direct invocation path this is adequate for this narrow ordering example, but it must not be promoted to a general race/expiry qualification.
- Count50 is consistent:16 named scenarios per current/jsonwebtoken/jose variant plus two async scenarios. The key-rotation scenario combines old-key rejection and fresh-key success; this is disclosed instead of inflating assertion totals. The direct receipt is producer-captured evidence; I did not independently execute it.

## Recommendation

The report is fair to both candidates and the existing implementation. jsonwebtoken fits current synchronous callers; jose needs coordinated awaiting across every caller. Stronger required-claim/max-age configuration is present, rather than rejecting libraries on default-only policy differences. Neither experiment proves material custom parsing removal, so keeping the current Node-crypto implementation remains a legitimate baseline.

Proceed to the proposed consolidated policy adapter comparison before choosing a winner. Use library payload output, retain explicit CR-only framing/header/app/trust rules, and measure removed code and full caller changes. Signed ambiguous payloads, key configuration, subsecond/expiry-during-await boundaries and actual authority-path freshness remain open. No final adoption, whole-client acceptance, deployment or live authentication conclusion follows from these50 scenarios.

Disposition: useful actual-handler E3 evidence with one small receipt assertion correction; no blocking source-fidelity finding for the bounded comparison.

## Focused correction disposition

2026-09-08, source/receipt recheck; no independent execution. **The P3 is closed.** The old-captured-trust scenario now captures the service counter before dispatch, computes the actual delta, asserts zero, and records that measured value. `f8-jwt-http-recheck-evidence.json` records exit0 and all50 named scenarios, including measured zero-call rejection for all three variants.

The added caller map is an identification/planning inventory, not migrated or executed coverage. The main conclusion remains conditional: both finalists fit this selected handler under explicit adaptation; all-caller async propagation, consolidated parsing, freshness/authority and final selection remain open. No remaining finding blocks accepting this bounded research receipt.
