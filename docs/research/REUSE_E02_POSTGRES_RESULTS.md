# E02: real PostgreSQL queue and integration evaluation

Date: 2026-09-06. Local baseline `7dc025d8b65324c5a3e3be651bb5b279fed00d87`; research-only additions remain uncommitted. See [authorized packet](REUSE_E02_POSTGRES_PACKET.md), [E01](REUSE_E01_PG_BOSS_RESULTS.md), and [acquisition/cleanup ledger](../REUSE_DOWNLOAD_LOG.md).

## Decision from this evidence

**pg-boss remains the leading queue component and is suitable for the next bounded integration experiment.** Its real PostgreSQL implementation passed concurrent claiming, transaction rollback, same-ID reconciliation, restricted-role repair, retry limits and stop/restart persistence. We can reuse those mechanics instead of writing another polling/retry engine. This is not approval for deployment, automatic native dispatch, schema migration into production, or unrestricted worker database credentials.

The integration still needs a thin Control Room adapter and an explicit cutover. Permanent authorization/attempt history and native-start reconciliation must remain outside disposable queue history. pg-boss runtime SQL targets the `job_common` partition directly; granting only its parent `job` table is insufficient. Restricted-role behavior is now observed, not guessed.

## Environment and authority

- Owner approved one disposable Mac PostgreSQL cluster for up to 20 minutes, no TCP listener, synthetic data, mandatory shutdown.
- PostgreSQL 18.4 binaries from pinned `@embedded-postgres/darwin-arm64@18.4.0-beta.17`; pg-boss 12.30.0 from E01; pg 8.23.0 already acquired in E01. No additional queue library installed.
- Exact binaries/cache/data stayed under the E02 root. Settings and `lsof` verified Unix-socket-only access and owner-only socket permissions before test work on each start.
- One cluster initialized; four short starts including one stop/restart in the initial run and two targeted follow-ups. First start 15:02:05 UTC; final shutdown 15:07:21 UTC (about 316 seconds), within the original deadline.
- Native scope was PostgreSQL only. No provider calls, Hermes/Codex runs, Keychain operations, VPS access, application activation or GitHub writes/Actions.

## Results, including the initial failure

| Check | Observed outcome |
|---|---|
| Real-PG transaction | Synthetic intent/audit markers and pg-boss submission committed together; forced rollback left neither marker nor job. A simulated lost acknowledgement reconciled the persisted UUID; duplicate submission returned null. |
| Concurrent pickup | Two separate connections/pg-boss instances each claimed 20 of 40 jobs; union exactly matched all submitted IDs and had no overlap. Both completed their jobs. |
| Locked row | One connection held a row lock; another fetched the other eligible job without waiting for that lock. The locked job became fetchable after release. |
| Initial restricted-role test | **Failed** with 42501: permission denied for table `job_common`. Initial grants to `job` did not cover direct partition SQL. Six other initial checks passed; command exited 1. |
| Focused role correction | Reproduced denial, then granted submitter SELECT/INSERT and worker SELECT/UPDATE on exact `job_common`. Submit, fetch and complete passed. Submitter could not fetch; worker could not submit. Neither could delete jobs, create or alter tables. Private role could neither read nor insert. Follow-up exited 0. |
| Retry/cancel/deferral | One allowed retry then failure; cancelled and future jobs were not fetched. |
| Actual server restart | Committed completed, active and unclaimed identities survived stopping and starting PostgreSQL. Only unclaimed work could be fetched. This was clean server restart, not an OS/power-loss test. |
| Existing schema | All **57 existing SQL migration files** and the existing private-web role script executed on the empty real PostgreSQL database. The resulting private-web role could not read the candidate queue. This is syntax/setup evidence, not full application acceptance under all roles. |
| Actual Control Room capacity code | `ResourceReservationStore` used separate real transactions. Two simultaneous requests for a one-unit resource yielded one success and one `resource_unavailable`; exact replay preserved the winner. Release let the other request succeed. |
| Disconnected unknown work | A fetched synthetic job with a one-second expiry and zero retries was left active when its client closed. Explicit pg-boss supervision changed it to failed after expiry; another fetch returned empty. No external operation was executed, so this does not prove native reconciliation or stop. |

Totals: initial run **6 pass / 1 fail**; focused corrective run **1 pass**; domain/recovery run **2 pass**. Nine distinct checks eventually passed across the runs, preserving the failed original role configuration as negative evidence. No skipped case is counted as passed.

## Precise integration implications

1. Keep database migration/queue creation privileged and separate from runtime. The tested role recipe was specific to the default shared partition and only submission/manual fetch/completion; per-queue partitions, dead-letter handling, scheduling and supervision require their own examined grants. Do not grant ALL or ownership merely to make a check pass.
2. Parent `job` permissions do not imply direct `job_common` permissions. Name the runtime target tables in role preparation, with schema drift/version checks. Worker identities on laptops still must not receive global database credentials; these are server-side roles.
3. The capacity store passed a real contention case. Engine worker slots do not replace canonical capacity/eligibility or project authorization; integrate reservations and submission deliberately.
4. Unknown native starts must use retry-disabled delivery plus durable reconciliation policy. A failed queue row is not proof that the native run failed or stopped.
5. E02 transaction markers are **not the complete canonical approval fixture**. E01 exercised the real approval coordinator on PGlite; E02 exercised marker atomicity and the actual reservation service on real PG. These are complementary evidence, not interchangeable claims.

## Remaining before selection/cutover acceptance

- Real-PG end-to-end canonical approval/intent/audit transaction, including commit-time revocation and loss of acknowledgement through the final adapter.
- Queue creation/cache invalidation and roles for the exact selected topology. Resolve E01's cold-cache behavior without using a live fetch as metadata priming.
- Controlled process crash/recovery, schedule execution/DST/missed-run policy, durable review/revision handoff and capacity integration, drain/version overlap, and actual backup/restore.
- Final dependency/license notices and security/version review before shipping an adopted dependency. The test binary distribution is not selected as the production PostgreSQL installer.
- Native agent activation and first browser-to-agent-to-result-to-review journey remain separate, authorized acceptance work.

DBOS remains the alternative if measured durable review/workflow requirements cannot be met cleanly with a thin adapter. E02 supports not introducing Hatchet or a second queue engine without a concrete unmet requirement.

## Reproduction and cleanup

Script: `scripts/research/pg-boss-postgres-evaluation.mjs`. It requires explicit E02 roots/authority environment values, refuses existing data on a fresh run, disables IP listening, bounds commands and shuts down in `finally`. A follow-up requires the original first-start timestamp and cannot reset the authorization clock. This is an opt-in local experiment, not a production supervisor or a reusable standing authorization.

The initial run used plain Node; the domain/recovery follow-up used `node --import tsx` to import the unchanged TypeScript reservation store. Syntax and targeted ESLint checks passed. Existing application manifests/lockfile are unchanged. Full repository test/build suites were not rerun for this research-only addition.

`pg_ctl status` confirmed no running server, PID/socket absence checks passed and no open data-directory handles were found. Deleted the exact disposable data and socket directories and verified absence. Retained approximately 197 MiB of logged binary/cache assets for a subsequent explicitly authorized evaluation; no standing service or database remains. Detailed paths and failed-attempt provenance are in the local-only download ledger.
