# F1 calendar adaptation feasibility — public cron-parser interfaces

2026-09-08. Source-only follow-up to `f1-calendar-fit.md`; no candidate rerun, downloads, database/service, application edit or new parser implementation. Inspected installed cron-parser5.10.0 public exports/types/README and exact implementation already hashed in `f1-calendar-pins.json`. This maps a representative replacement seam for root, not approval to change accepted schedule semantics.

## Strongest available seam

**Public `CronExpression.includesDate(Date)` is the smallest calendar-matching replacement to test first.** It uses the expression's configured timezone, checks second/minute/hour/month field values, and calls the same day-of-month/day-of-week matching implementation used by the iterator (`CronExpression.js:304–317,343–371`). It does not ask next() to repair a nonexistent local time. Keeping the existing bounded UTC-minute iteration and local-time-key deduplication would therefore avoid the observed iterator gap-shift policy while replacing standard field matching and, subject to grammar adaptation below, expansion.

Public package exports expose `CronExpressionParser`, `CronExpression`, `CronFieldCollection`, `CronDate` and individual field classes (`dist/index.js`, `dist/types/index.d.ts`). `CronExpression.d.ts` declares `includesDate`, `fields`, next/prev and field construction; this is not an internal import. `CronFieldCollection.from` and field manipulation are documented in the shipped README at319–349 and actual types. `CronField` options expose `rawValue` and `wildcard`; `values`/`isWildcard` and serialized values are public. `CronExpression.fieldsToExpression` is public, although its implementation expects a field collection despite a misleading loose comment; use actual published types, not that comment.

The source supports preserving raw wildcard intent with `CronField` options rather than reconstructing it from expanded values. Direct `includesDate` replacement still needs the compatibility gate below; simply parsing existing input with `strict:false` is **not** complete parity.

## Current syntax versus upstream semantics

These are source-backed observations/inferences, not new runtime passes. Root's representative test should execute each.

| Form or policy | Existing CR `recurrence.ts` | cron-parser5.10 implementation | Consequence |
| --- | --- | --- | --- |
| Exactly five fields, numeric syntax only | Requires five; no seconds/aliases/special symbols | Non-strict accepts shorter forms/default padding and six fields; predefined expressions and named months/days supported | Retain a narrow five-field lexical admission gate; do not silently expand product syntax. |
| Restricted DOM and DOW | OR | OR with strict:false; strict:true rejects both and expects six fields | strict:true is not a drop-in safety switch. |
| `1-5/2` |1,3,5 | Range starts at1 (`#createRange`) | Compatible bounded expansion. |
| `1/2` | Singleton1, because current range end equals start | `#parseRepeat` expands bare start to field maximum, producing1,3,5… | Must preserve accepted legacy meaning explicitly. A narrow validated singleton-step normalization to singleton is feasible; do not replace it with upstream's different meaning or reject existing schedules without migration authority. |
| `*/1`, numeric full range, or wildcard inside a list | Wildcard flag true **only if whole field exactly `*`** | Field rawValue similarly recognizes exactly `*` or `?`; no inference from expanded values when rawValue supplied | Keep original exact-star flag when constructing combined fields. A full range is not automatically a wildcard for DOM/DOW policy. |
| Duplicate/overlapping lists such as `1,1` or `*,1` | Set union, accepted | Sequence concatenates values; field validation rejects nonzero duplicates | Whole-expression parse can reject currently valid input. Public per-segment field expansion followed by set union and public field construction is a plausible adaptation, not yet tested. It uses upstream expansion, not an authored range expander. |
| Leading-zero numerals | Rejected by canonical-number regex | Numeric conversion/parseInt accepts some noncanonical forms | Preserve canonical numeral gate. |
| Step larger than complete field span | Rejected even if singleton | Upstream only requires positive repeat; may return one item for oversized steps | Keep current step bound in compatibility validation. |
| `L`, `#`, `?`, `H`, named day/month, `@daily` | Rejected | Supported special syntax/aliases/predefined/hash features | Explicitly reject before parsing for existing contract. No new product feature is implied. |
| Sunday7, lists/ranges including0/7 | Normalize7→0 and deduplicate | Upstream sequence normalizes singleton7, ranges have special Sunday handling and may retain7 alongside0 | Include equivalent Sunday lists/ranges in the parity fixture; using a numeric-field union may normalize7→0 as retained CR policy, not a new calendar engine. |
| Paused/disabled, once, anchored interval, bounded range | Existing public API behavior | Outside cron matching responsibility | Retain unchanged; do not force these into cron expressions. |

Exact call sites: `CronExpressionParser.js:104–124` field defaults; `:74–95` parse, strict gate and raw-field construction; `:134–159` aliases/wildcards; `:287–315` list concatenation; `:324–335` bare-number step expansion; `:359–401` step/range validation and generation. `fields/CronField.js:55–68,193–211` field duplicate and wildcard policy. `CronDayOfMonth.fromMonth` additionally prunes impossible day values for a single named month; its effect with OR-day rules and wildcard metadata belongs in the fixture, not an assumed blocker.

## Two realistic adaptation options

### A — parsed fields plus public includesDate, retain bounded scan

Retain canonical lexical/step policy admission, current start/end cap, active-state handling, UTC-minute scan, local formatter and occurrence identity. Obtain field values from the maintained parser rather than authored expansion. For compatibility exceptions, test public segment parsing/union/field construction with exact wildcard flags; avoid copying private `#parseField` or writing another expansion loop. Construct the expression using public field classes/collection and configured timezone; call includesDate at real UTC minutes, then preserve existing local-key deduplication.

Potential removal: custom range/list expansion plus `cronMatches`' standard membership/day logic. Retention: a smaller compatibility gate and product-specific state/window/identity policy. The exact net line count and complexity are unmeasured. If preserving unusual accepted forms requires more glue than expected, root can compare scope-limited migration/validation choices explicitly; “custom is safer” is not established by the default parser mismatch.

### B — next() iterator plus actual wall-time matching filter

Public next() can reduce scanning for sparse schedules. Filter each returned actual instant with includesDate (or equivalent public field matching) before admission, which source suggests rejects the observed spring03:30 value for02:30. Preserve start-inclusive/end-exclusive handling, actual local-time dedup and bounded work/no-occurrence termination. This removes more scanner work, but depends on iterator candidate generation not omitting valid matches after rejected gap output. Needs representative sparse/no-occurrence/month-boundary/DST evidence; it is not automatically better from fewer callbacks. Do not use pg-boss's prev-window policy as an equivalent missed-window enumerator.

**A is the lower-change representative experiment**, not a final winner: includesDate does not shift dates, and no new iterator progress policy is needed. B remains a legitimate maintained alternative if its broader deletion benefit justifies the additional finite cases.

## Precise root experiment and authority boundary

Build a research-only candidate at the existing effect-free calculator interface; do not edit production or replace durable occurrence logic. Cover existing ordinary cron/OR/range-step cases plus singleton-step, duplicate/wildcard lists, canonical numerals, step bounds, Sunday aliases, impossible dates, both DST transitions, bounded windows and once/interval/state rejection retention. Require byte-identical occurrence keys/UTC dates/local times and safeReason results, not just counts. Then root separately determines actual recurrence→occurrence/outbox acceptance, cross-window replay/conflict policy and missed-window integration. The existing store's tenant/schedule/key and exact replay guards remain authoritative; public field APIs do not replace them.

No library upgrade, upstream fork or new generic scheduler is necessary to run that comparison. A production direct import should declare cron-parser as an intentional direct dependency at the reviewed pin rather than rely on pg-boss's transitive resolution, and carry MIT/transitive notices. This source task does not close licensing, scheduling E3, queue selection or deployment.
