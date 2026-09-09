# DR-09: public cron-parser matching, existing Control Room schedule policy

2026-09-08. Root accepts the actual adapter comparison and independent review.
Select cron-parser5.10.0 public field expansion/includesDate for the existing
calculator. Retain bounded UTC scanning, legacy grammar, local-time keys and
state/window rules. This is a planned primitive replacement, not a work-engine
selection or completed durable scheduler.

Actual public interfaces inside the real calculator shell match42 selected full
results after one disclosed impossible-date compatibility correction. Initial41/42
failure and corrected truncated output/exit0 remain recorded. Retaining the current
parser avoids integration but retains bespoke expansion/day matching; no concrete
advantage justifies that standard custom responsibility over this tested adapter.

Alternatives were materially different: actual DBOS TimeMatcher has different
restricted DOM/DOW and range-step semantics and is an internal interface. Plain
cron-parser next() shifts the tested missing time; pg-boss prev-window dispatch
is not the current missed-window enumerator. Neither is a drop-in calculator.
Iterator-plus-filter may improve sparse scanning but adds progress/boundary cases.
Retain the existing bounded scanner for this replacement; revisit that separate
optimization for a measured bottleneck, not merely to maximize imported code.

Cost: no new service, fork, database or policy migration. Declare the already
installed parser directly and preserve its MIT/transitive notices. Research replaces47
densely formatted lines with35 compact glue lines plus imports/call sites; this is
not promised net production savings. Retained glue includes canonical numerals,
singleton steps, union/Sunday/wildcard semantics and the exact impossible-date case.

Implementation acceptance: typed integration and reproducible full parity output,
pin-sensitive impossible-date/rescued-DOW regression checks, input/resource bounds,
and actual occurrence-store replay/window tests. The VM timeout bounds loading,
not calculation. Never broaden catch-to-empty after a package upgrade. This narrow
selection does not reopen merely because production or target acceptance remains.

Evidence: `f1-calendar-fit.md`, `f1-calendar-root-disposition.md`,
`f1-calendar-adaptation-map.md`, `f1-calendar-adapter-fit.md` and independent
`f1-calendar-adapter-review.md`. No production source changed.
