# CR14C — native recovery authority acceptance

Date: 2026-09-05. Independently accepted unwired recovery composition.
Base: `0f08240c5366ee745694a305b874e8ba4c1a70c0` / PR #302.
Accepted product/test head: `271eff68a2235d28e4bd98f47a017564b916b0ca`.
Tree: `4d49001d89f2cc24e2633d72e6221f3c479c6726`.
Contract: `CR14C_NATIVE_RECOVERY_AUTHORITY_CONTRACT.md`.

## Delivered

Separate signed exact-binding recovery permits status/stop for an already recorded native run, including
after durable execution expiry. It requires the real marker-bearing effect, matching execution and known
native ID, current trusted key/credential/recovery policy and accepted profile evidence seam. Its fixed
expiry cannot exceed enrollment or five minutes beyond the work deadline. It cannot renew execution,
create a marker, settle/release an effect, attach an unknown ID or submit work.

The combined authority routes status/stop exclusively to recovery and start/capabilities/events to the
existing start controller. No failed-permission fallback exists. The actual adapter's durable stop intent,
final-byte authorization and unknown-outcome behavior remain authoritative; no second stop ledger was
added. Tests preserve expired local state and unresolved effects after a stop acknowledgement.

## Independent review

`cr14c_recovery_authority_review` accepted the exact head/tree above with no blocking findings.
Stage zero passed; its requested adapter/start/recovery/isolation suite passed **56/56**, exit 0,
no skips. It reviewed separate signing, durable identity, non-renewal, stop deduplication, final-byte
revocation, deadlines and unresolved resolver bounds. No files or external state were changed by review.
Final architectural acceptance remains Codex's responsibility.

## Verification

- Stage zero ready; no native readiness/qualification attempt.
- New recovery suite: **11 passed**; final TypeScript and changed-file ESLint passed.
- Full ESLint and whitespace passed.
- CR14C suite: **300 passed**, no failures/skips.
- Full lifecycle pretest: **769 passed**; main: **879 passed**, two existing platform skips (881 total);
  posttest: **392 passed**. Every lifecycle command exited 0.
- Private Node build and **16 compiled tests** passed.
- Separate Sites build and **four rendered tests** passed.
- Disposable migration verification: 0001–0046, **132 tables**; no schema change.

The initial TypeScript check found four implicitly-any method parameters in frozen object literals.
Explicit existing NativeOperation/NativeBinding types corrected those diagnostics; no permission or
behavior was relaxed. The first 11 runtime tests passed, and all final verification targets the accepted
product. Tests use real disposable canonical/start journals plus synthetic keys and explicitly fake
transport/current host evidence, not owner signing custody, physical stop or native qualification.

## Remaining and authority

Next on Astra Medium: real trusted current authority sources, owner signing/intake, signed coordinator
dispatch and bounded revision submission, followed by scoped live validation. This block does not mount
runtime services, collect credentials, sign with an owner key or make a native/provider request. No
deployment, real database/listener, install, merge or production qualification occurred. Current-head
GitHub CI and dependency-order integration remain required; full C-WORK remains incomplete.
