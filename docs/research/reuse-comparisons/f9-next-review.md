# Root review of RC10 next-tool evidence

2026-09-08; author scope at fbac95b. Root read actual harness, report and saved
receipts; did not rerun the removed candidate installation.

The disposition is supported: neither command produced an acceptable full report.
The harness returns success for recording results, not for passing either candidate;
its saved child statuses explicitly retain CycloneDX254 and pnpm1. No ignore-errors
option, package-manager repair or production dependency mutation was used.

The39-identity comparator follows required and installed optional manifest edges.
It is not proof of peer correctness, other platforms' optional dependencies, or the
entire shipped artifact inventory. Those limitations are stated. The compiler/bundle
and copied-source inventories remain separate. A failed command's omitted list means
no usable report, not silent omission from a successfully generated SBOM.

The next step is properly a disposable dependency preparation with complete store
metadata, followed by the existing native pnpm inventory, not rewriting its resolver.
CycloneDX remains viable on a supported graph; its failure on this checkout does not
justify universal rejection. No final RC10 selection or licensing clearance is granted.

No blocking reporting defect found within this bounded negative-evidence scope.
Exact package graph and script-disabled acquisition records are retained, and the
author recorded removal/absence of its70MiB owned temporary cohort. Root did not
independently observe the earlier deletion command; this cleanup evidence is attributed
to the author's retained record rather than presented as a root-operated cleanup.
