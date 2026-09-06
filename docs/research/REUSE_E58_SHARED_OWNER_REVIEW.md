# E58 — shared human-readable owner review

2026-09-06. Local integration only; no credentials, native calls or deployment.

The existing protected prepare endpoint and the E57 issuer now use one review
projection. It describes the exact bound prompt/instructions, project, task, attempt,
node, provider/model and deadline. It excludes internal enrollment, credential and
destination fields. Binding verification runs before projection, and the input digest
is derived from actual content instead of accepted from a supplied summary.

The issuer exposes this immutable review before `issue` is invoked. Its consent digest
now binds both the human-readable review and the two unsigned signature bodies. This
lets a future trusted local consent surface present what is being signed instead of
displaying only a hash. It does not itself implement consent, request transport or a
new website control. No internal enrollment fields were added to the HTTP response.

The protected endpoint retains its existing wire schema and scope checks. It additionally
checks the derived content digest against the authenticated requested digest. Both
consumers reuse existing task-binding/schema primitives, without another signing or
transport protocol. A substituted prompt fails binding rather than changing the review.

Verification: 18 canonical-storage/protected-HTTP checks, nine actual-package signing
diagnostics, TypeScript and targeted lint pass. Production build and all 35 compiled
regressions pass; existing build deprecation warnings remain. This is not browser
interaction, real owner attendance, fleet qualification or a new full-suite run.

Next: trusted prepared-request delivery and local consent/custody composition, alongside
executable host configuration. The website still cannot issue owner signatures, and
the private issuer still requires a supplied current-consent guard and signer.
