# Canonical review on native PostgreSQL

2026-09-08. Runner mode `review-native` in f1-postgres-run.mjs uses the already
approved pinned PostgreSQL18.4 distribution and fresh private Unix socket cluster.
No new downloads, production connection, TCP listener or provider operation.

## Actual result

Final command: `node --import tsx research/reuse-comparisons/f1-postgres-run.mjs /private/tmp/cr-compare-f1.9x5bSO review-native`.
Exit 0. Direct terminal output:

```json
{"backend":"PostgreSQL18.4","canonicalAllocations":1,"supportingPgliteAllocations":1,"pendingReview":true,"releasedCapacity":true,"reconstructedExactReceipts":true,"additionalNativeCalls":0,"limitations":["synthetic transport and owner review","fixture owner role, not production roles","object reconstruction, not process restart","queue candidates not yet joined"]}
{"cleanup":true,"clusterStopped":true,"scope":"owned disposable child only"}
```

Main task/review fixture identity is asserted equal to the actual bounded PostgreSQL
client. Existing migrations and canonical services run unchanged. Additional trust
material support uses its separate PGlite fixture; it is not represented as shared
PostgreSQL state. Real native effects and owner consent are not performed.

## Preserved setup failures and correction

First sandbox attempt failed initdb shared-memory allocation; zero scenarios ran,
owned child removed. Approved outside-sandbox attempt reached fixture execution
but failed the one-allocation assertion: the existing helper chain creates a second
support fixture. Cluster stopped and owned child removed, exit 1.

Corrected explicit fixture injection to allow the support fixture's normal PGlite
backend. Added the decisive main-client identity assertion, retaining the real
PostgreSQL requirement for canonical review. The subsequent run above passed.
No application contract, migration, review requirement or queue check was weakened.

This closes native-database preparation for the joined comparison, not queue
selection, process-crash recovery or production PG17 role acceptance. Next reuse
this exact main database/client with candidate queue submission and worker APIs.
