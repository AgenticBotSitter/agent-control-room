# Public cron-parser matching inside the current recurrence calculator

2026-09-08. Effect-free research; actual installed cron-parser5.10.0/Luxon3.7.2,
existing `f1-calendar-pins.json` source hashes checked before imports. Stage zero
returned `ready_for_runtime_check`. No installs, downloads, database, scheduler,
services, application writes or occurrence-store execution.

## Result and preserved correction

The first42-case comparison matched41 cases. The corrected run exits0 after all42
full-object parity comparisons. Command:
`TZ=UTC node research/reuse-comparisons/f1-calendar-adapter-fit.mjs`.
The [receipt](f1-calendar-adapter-evidence.json) preserves the complete first failure
output and corrected tool result. Corrected output was tool-truncated; its exit0
follows the final all-rows assertion, but it is not a complete raw stdout capture.
No additional rerun was performed merely to change receipt formatting.

Only mismatch: `0 0 31 2 *` is accepted by current CR with zero occurrences and no
safeReason, whereas public `CronFieldCollection` rejects it as an impossible explicit
day. Its inspected constructor checks a sole month plus wildcard DOW and emits
`Invalid explicit day of month definition`. The one focused correction maps **only
that constructor error**, after all fields pass canonical validation, to a never-match
calendar. Unknown errors still become invalid_schedule. Restricted DOW rescues31Feb
through OR semantics in both implementations and already passed before correction.
No new month-length table, range expander or change to existing schedule grammar.

## What actually crosses the interface

The fixture reads the hash-pinned real `src/services/v1/recurrence.ts`, removes its
`parseField`/`parseCron` and `cronMatches` bodies in memory, and substitutes the public
candidate. It transpiles both original and adapted modules with the same TypeScript
tooling and invokes their real exported `calculateScheduleOccurrencesV1`. It does
not edit the application file or substitute a look-alike top-level calculator.

Actual `CronExpressionParser.parse` expands each validated segment independently;
public field `values` feed a set union, with existing Sunday7→0 normalization.
Public field constructors preserve the original raw whole-field wildcard intent.
Public `CronFieldCollection`/`CronExpression.fieldsToExpression` construct matching;
actual `includesDate` evaluates each real UTC minute in the configured timezone.
No private upstream method or copied expansion loop is used. The existing bounded
scan, local-time formatting/deduplication, keys and once/interval/state/error paths
remain unchanged. The impossible-date sentinel is disclosed adapter behavior, not
claimed native includesDate support for that rejected expression.

42 comparisons include the prior six calendar cases; singleton steps; duplicate,
overlapping and wildcard lists; exact-star versus full-range/step/list DOM intent;
Sunday0/7/ranges; impossible dates with/without restricted DOW; sixteen invalid
grammar forms; paused-before-invalid-expression, disabled, invalid timezone/id;
once, anchored interval, fractional-minute boundary and oversized window.
Full JSON objects (not only counts) are compared: scheduled UTC strings, local times,
occurrence keys, schedule IDs and safeReason values. Hashes in the receipt summarize
the compared outputs. This is a bounded corpus, not exhaustive cron equivalence.

## Actual adaptation/removal cost

The two removed source spans total47 non-trailing lines at this source formatting:
custom parseField/parseCron expansion and cronMatches membership/day logic. The
authored `compileCron` function is35 compact physical lines after correction, plus
public imports and two call-site substitutions. Its dense formatting is not a
production maintainability estimate or a promise of net12-line savings; normal
formatting/types/tests will add lines. Existing now-unused CronField/CronExpression
interfaces would also be cleanup candidates after production type review.

Responsibilities genuinely delegated: numeric range/step expansion and standard
timezone date matching/day OR rules. Responsibilities retained: canonical numeric
syntax and step bounds, singleton-step legacy meaning, duplicate-set semantics,
Sunday normalization, wildcard intent, impossible-calendar compatibility, UTC scan
limits and durable identity policy. No framework, service, async caller migration
or upstream fork is added. A production import should declare the existing parser
pin directly rather than depend accidentally on pg-boss's transitive resolution.
MIT and transitive notice obligations remain distribution work.

Compared options: retaining current code avoids dependency/glue changes but retains
its bespoke expansion/matching. Plain upstream parsing/next iteration has already
observed grammar/DST mismatches. This public matching adapter resolves the selected
cases with limited compatibility glue; the iterator-plus-filter alternative may
remove more scanning but is not tested here. Root should weigh that potential
benefit against added iteration/progress cases, not assume “more upstream” is cheaper.

Measured combined baseline/candidate corpus time was271.67ms first and278.20ms corrected
inside the harness. This is not a candidate-only latency or memory benchmark. No
durable occurrence acceptance, missed-window outbox delivery, cross-window replay,
production scheduler or queue choice is established. Root independently reviews
the adapter and decides the implementation boundary; no migration/policy decision
is made here.
