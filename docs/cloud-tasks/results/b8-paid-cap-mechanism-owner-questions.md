# b8-paid-cap-mechanism — owner questions

Neither question below blocks BUILD of the stand-in mechanism. Both only set constants, and the tests in the spec use their own synthetic values.

1. **Per-run cap ceiling.** What is the maximum `capNanoUsd` the owner may consent to for one run (`PAID_RUN_CAP_CEILING_NANO_USD`)?
   - **Recommendation:** `5000000000` (USD 5) as a **test-only stand-in value**. It is not a production or tiny-probe spending authorization; those require explicit later owner decisions.
   - **Affected work:** the admission constant (spec §3.2 rule 4) and the T9 range cases.
   - **Blocked without an answer:** nothing in BUILD. Only the fake-provider tests use the recommended pending value. Production/tiny-probe cap policy remains blocked until explicitly decided, in addition to spec §8.5 technical gates.

2. **Consent lifetime.** How long may a fresh per-run consent remain valid before Start must use it?
   - **Recommendation:** 10 minutes.
   - **Affected work:** spec §3.2 rule 3 and the T9 expiry cases.
   - **Blocked without an answer:** nothing. The fake-provider mechanism uses the recommended **test-only** value. Production consent lifetime requires an explicit later owner decision; this cannot authorize a real probe.
