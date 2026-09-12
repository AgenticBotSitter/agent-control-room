# Independent native PG17 restore fit review

2026-09-08. Source/evidence only; no native execution, services, downloads, migrations, credentials or application changes. Read the assigned fixture, report, final/preparation evidence, actual preflight ordering and retained five-attempt observation files. Root retains schema/security and implementation decisions.

## Finding: narrow the exact-difference claim

**P2, report precision.** `schema-differences` filters restored manifest rows against a source map. It detects changed or new restored entries, but does not enumerate source entries absent from the restored manifest. Thus the receipt establishes **one detected changed manifest entry**, not independently that this is the only possible manifest difference. There is no retained bidirectional full-manifest comparison in the assigned evidence. Narrow that sentence, or point to existing complete equality evidence; no unchanged restore rerun is requested solely for wording. The mismatch itself and failure of exact fingerprint acceptance are established.

## Native tool choice and application seam

The native tools genuinely run: inventory-bound64 website migrations and role files feed a new PG17 cluster; native custom-format pg_dump/list/pg_restore target an empty second database without dropping ownership/ACLs. A real restricted pg login crosses actual boundedDatabase, source verifyPrivateDatabase and WebProjectService. This is representative E3 for logical backup/tool-to-application fit, even though restored overall acceptance is deliberately false. It is sufficient to retain native logical restore as the implementation direction; a failed application fingerprint does not justify a custom backup serializer or repeating a pgBackRest product contest.

Preparation records copied-signature/system-policy acceptance,16 hashed library/tool entries and six actual version17.11 outputs. The fixture trusts `verification-ids.json` prepared=true rather than independently rehashing every executable immediately before invocation; it relies on the inspected owned preparation cohort. Treat this as that staged provenance, not a general arbitrary-path secure runner or full optional-package licensing clearance.

## What actually restored—and what did not get qualified

- The source snapshot enumerates all145 public tables and compares sorted JSON row counts/digests;11 have synthetic rows. It also compares public relation owners/ACLs and public function owners/ACLs/security-definer flags. The native dump is whole-database; the comparative census is public-schema data plus these selected catalog projections, not every possible PostgreSQL object/global configuration.
- Coalescing null relation/function ACLs with PostgreSQL defaults is a defensible effective-grant comparison, not removal of permission checks. This is not a claim that every future default privilege, sequence current value or cluster-global role definition was independently restored and compared.
- Cluster roles are pre-existing in the same fresh cluster; the target database ACL procedure is applied separately. The report correctly does not claim pg_dump transferred roles, passwords or a complete independent-cluster bootstrap. Website-only excludes selected agent/task-authoring role acceptance.
- The restored preflight reaches session/role/unsafe/column-permission checks before its fingerprint comparison (`private-database-preflight.ts:251–290`). Reaching the recorded fingerprint is valid evidence those earlier gates did not reject. The later exact owner-binding query at291 onward is **not reached** after the mismatch. Source preflight passed, rows were preserved, and a subsequent actual project list succeeds; neither is an executed restored owner-binding preflight pass.
- Four forbidden-operation promises reject, but assertions accept any error and do not retain individual SQLSTATE/cause. Do not call those four independently diagnosed permission errors. The actual preceding permission checks and valid SQL contexts provide complementary evidence; final restricted preflight remains failed.
- Artifact bytes are copied between owned local files and checked with the actual byte/hash helper; missing/tampered cases are retained. A project summary holds the digest. This is not a native artifact manifest/receipt, a paired transactional backup, off-host copy, or producer/file authorization. Those limitations are correctly explicit.

## Fingerprint finding and preserved failures

Source and restored digests differ, and the detected constraint definition differs in grouping of the same three AND terms. That specific displayed conjunction has unchanged conditions; it explains a real exact-text sensitivity. It is not blanket equivalence verification of the entire restored schema. The fixture retains restoredPreflight=false, continues only independent research observations, then asserts false and emits failure. It never starts the application or converts the failed gate into success.

All five named retained attempt files exist and end with clusterStopped/cleanup true. Initial ACL assertion messages are capped, so these retained summaries do not reconstruct every intermediate source revision or independently prove the entire stated uppercase/lowercase authoring history. They do preserve failures rather than erase them. The successive diagnostics are clearly distinguished from successful acceptance; no all-green count is manufactured.

Cleanup ends tracked clients, stops the exact owned cluster and checks absence of its postmaster PID before removing the run directory. Normal rm completion supports recorded run removal, not an independent OS-wide process inventory. The package root and failed/success observation files remain intentionally retained; “disposable run removed” must not be expanded to “all downloads cleaned.” Per-command timeouts and query limits exist; the report makes no unmeasured memory/throughput claim.

## Implementation disposition

Retaining native logical tools is justified without building the full backup subsystem during comparison. Root-reviewed restore-stable schema validation is a concrete A1/D1 implementation issue. Evaluating an additive semantically equivalent CHECK migration and first/second restore stability is a reasonable next implementation test, **not an approved schema change here**. Preserve changed-bound/dropped-constraint/excess-grant/missing-owner/changed-data negatives; do not disable the fingerprint or add arbitrary accepted hashes.

Production private authentication, separate role provisioning, canonical artifact pairing, independent retention, actual persistence/replacement and target restore remain acceptance work. The packet closes a useful representative tool-fit question while finding an application blocker; it does not close D1 or certify a production restore.
