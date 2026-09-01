# CR12B-IDEA-110L regex-execution capture independent review — REV-001

**Disposition:** `remediation_required`

**Reviewed product commit:** `c31a00b388292fe5af404f71eb2802b6aed52d1f`

**Review checkout head:** `aeb0ac1`

**Frozen packet SHA-256:**
`bfaef5a2c48930bf194af91f7d4cc844bc1492763632c03dddff9dd79c37cef6`

## Independence and effect boundary

The completed reviewer was different from the IDEA-110K reviewer and every IDEA-110F through IDEA-110L contributor.
The review made no repository edit, commit, push, install, download, network request, native launch, provider call,
credential access, or external effect.

## Closed inherited findings

The reviewer reproduced IDEA-110K's mutable regex-exec and sparse-array defects against the rejected commit and
confirmed that IDEA-110L closed both. This closure does not override the new chronology findings below.

## Findings

### CR12B-110L-REV-FINDING-001 — Medium — chronology still resolved mutable ambient operations

**Exact source:** `src/idea-lab/v1/hermes-021-enrolled-connection.ts:256-258` at the reviewed commit, with the same
direct `Date.parse` and numeric/array dependency pattern in profile preparation, owner qualification, and live authority.

**Reproducible input:** After module import, replace `Date.parse` with a throwing sentinel and run a valid enrolled
connection. Then replace it dishonestly and evaluate an enrollment expiring at `2026-09-01T10:04:00.000Z` at
`2026-09-01T10:05:00.000Z`.

**Observed result:** The throwing sentinel escaped. Under the dishonest replacement, the expired route was reported as
accepted and qualification-profile eligible.

**Violated invariant / affected boundary:** Post-import ambient mutation could change expiry, ordering, duration, and
owner-window decisions across enrollment, profile preparation, owner qualification, and live-panel authority.

**Missing regression:** No end-to-end substitution tests covered `Date.parse`, numeric finiteness, or array-wide
chronology checks through the four security boundaries.

**Smallest safe remediation:** Route every Idea Lab chronology comparison and time construction through one
module-captured, fail-closed helper; remove ambient array-wide chronology operations; and add boundary regressions.

### CR12B-110L-REV-FINDING-002 — Medium — replacement datetime refinement accepted impossible calendar times

**Exact source:** `src/idea-lab/v1/schemas.ts:13-16` at the reviewed commit.

**Reproducible input:** Validate `2026-02-29T10:00:00.000Z`, `2026-02-31T10:00:00.000Z`, and
`2026-09-01T24:00:00.000Z` through the replacement Idea Lab datetime schema.

**Observed result:** The candidate schema accepted values rejected by the prior strict datetime validator because
JavaScript parsing normalized impossible dates and the replacement checked only syntax plus finite parse output.

**Violated invariant / affected boundary:** Signed evidence, permits, owner windows, and lifecycle records could carry a
nonexistent civil time while still satisfying the shared Idea Lab schema.

**Missing regression:** There was no differential calendar, leap-year, or hour-boundary test.

**Smallest safe remediation:** Validate month length, leap years, day, hour, minute, second, and offset bounds before
using the captured parser; retain valid fractions and offsets; and add invalid/valid differential tests.

## Verification

Stage zero, TypeScript, lint, CR12B 163/163, the complete npm lifecycle, production build, 3/3 rendered routes, all 32
migrations/110 PostgreSQL tables, and whitespace validation passed. Passing producer checks do not override either
finding. IDEA-110L remains rejected and grants no connector, native, provider, live-panel, deployment, or production
authority.
