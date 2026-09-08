# Root review: native prepared dependency inventory

2026-09-08, author base f2bac29. Root source/receipt review; no independent install
or runtime rerun. Actual fixture manifest/lock hash equality and exact39-name/version
comparison are explicit assertions in `f9-prepared-compare.mjs`. The underlying
candidate result is actual pnpm output from isolated frozen production preparation,
not manually generated dependency entries. Earlier graph-reader failures remain.

Accept the narrow native pnpm11.19.0 identity-graph recommendation for this prepared
runtime graph. This is independent of complete notices: all39 entries lack
licenseContents, and the actual pnpm implementation's manifest-label fast path
explains why. Neither a successful command nor correct identities is legal clearance.

The comparator's conventional root-file scan is diagnostic only. Filename matching
and emitted path prefix do not prove all nested LICENSE/NOTICE texts are included or
provide a production-grade symlink containment boundary. Four missing root matches
must use existing provenance records, not be labeled unlicensed. The report explicitly
limits those claims and leaves a complete external-package text step outstanding.

No blocking reporting defect for this narrow decision. Exact peer/platform/monorepo
coverage remains outside the39-required/installed-optional set. Lock/pnpm version
changes require fresh inventory comparison. Author's cleanup record attributes the
288MiB owned cohort removal/absence; root did not independently perform that deletion.
