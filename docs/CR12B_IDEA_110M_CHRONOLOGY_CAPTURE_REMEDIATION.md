# CR12B-IDEA-110M — captured chronology and strict calendar remediation

**Status:** Provider-disabled implementation frozen at `790524a7538f0e1d6c45e5023f5ecc3100e9c113`; fresh
independent review of the exact product is mandatory.

**Replacement review packet:** `docs/reviews/CR12B_IDEA_110M_CHRONOLOGY_CAPTURE_REVIEW_PACKET.md` at SHA-256
`0b779430173a003a1abe90aa527e428d2895fc42a4eb088d157ebc1e0b6e644d`.

## Why IDEA-110L remained rejected

Independent review of exact product `c31a00b388292fe5af404f71eb2802b6aed52d1f` confirmed its inherited regex and
sparse-array fixes, then reproduced two Medium chronology defects. Security decisions still called mutable ambient time
operations after import, and the replacement datetime refinement accepted impossible calendar values. The durable
report is `docs/reviews/CR12B_IDEA_110L_REGEXP_EXEC_CAPTURE_REVIEW_REV_001.md`.

## Structural repair

- one module-captured helper now parses, validates, compares, formats, and obtains Idea Lab timestamps;
- the validator checks leap years, month length, day, hour, minute, second, and timezone-offset bounds before parsing;
- enrollment, profile preparation, owner qualification, live authority, coordinator, persistence, lifecycle, and
  operator chronology no longer call ambient `Date.parse`, `Number.isFinite`, `new Date`, `toISOString`, or array-wide
  chronology helpers after import;
- database date formatting and generated evidence expiry use captured date construction and formatting; and
- regressions substitute hostile ambient time and array operations through the real enrollment, profile, owner, and
  authority boundaries while also testing impossible and valid leap-year/calendar inputs.

## Authority boundary

This remediation configures no private port, signer, route, native or SSH attempt, provider call, credential access,
live-panel permission, production database, deployment, hosting, or DNS effect. Fresh independent review of the exact
product commit and replacement packet is mandatory; acceptance may remove only the provider-disabled connector
implementation-review gate.

## Producer verification

- CR12B focused suite: 168/168 passed;
- repository preparation suite: 769/769 passed;
- core suite: 418 passed, zero failed, and two intentional platform skips out of 420;
- repository post-test suite: 247/247 passed;
- TypeScript, full lint, production build, 3/3 sequential rendered routes, all 32 migrations/110 PostgreSQL tables,
  macOS stage zero, and whitespace validation passed.

These are producer checks, not review acceptance.
