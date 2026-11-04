# b8-paid-cap-mechanism — owner questions

Neither question below blocks BUILD of the stand-in mechanism. Both only set constants, and the tests in the spec use their own synthetic values.

1. **Per-run cap ceiling.** What is the maximum `capNanoUsd` the owner may consent to for one run (`PAID_RUN_CAP_CEILING_NANO_USD`)?
   - **Recommendation:** `5000000000` (USD 5) for the stand-in and tiny-probe phases. Raise it only with the full paid-run acceptance.
   - **Affected work:** the admission constant (spec §3.2 rule 4) and the T9 range cases.
   - **Blocked without an answer:** nothing in BUILD. The constant ships at the recommended value and is marked owner-pending. Production enablement is blocked anyway (spec §8.4).

2. **Consent lifetime.** How long may a fresh per-run consent remain valid before Start must use it?
   - **Recommendation:** 10 minutes.
   - **Affected work:** spec §3.2 rule 3 and the T9 expiry cases.
   - **Blocked without an answer:** nothing. The recommended value is used and marked owner-pending.
