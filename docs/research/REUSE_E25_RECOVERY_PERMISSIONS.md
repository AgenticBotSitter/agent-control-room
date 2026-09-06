# E25 — exact recovery column permissions

2026-09-06. Offline candidate role/profile; no production grant changes.

## Decision and tradeoff

The public pg-boss retry/update composition requires UPDATE on 16 named columns across
job/job_common. update() mentions payload, scheduling and policy columns even when
preserving their values. Grant only those columns to the existing trusted coordinator;
do not grant table-wide UPDATE, DELETE, id/name/retry_count changes, schema creation,
queue-policy edits, browser queue access or canonical privileges to the queue worker.

This is still a meaningful privilege increase for the coordinator, including payload
and timing columns. The trusted recovery adapter supplies only retryLimit:0 and checks
canonical never-staged authority inside the same transaction. SQL grants alone do not
enforce that application policy. Retain independent and real-PG acceptance before use.
This avoids copying upstream queue SQL or introducing a privileged custom reset function.

## Implementation

db/roles/native_queue_recovery_roles.sql is an offline candidate applied only after the
existing producer role setup and explicit review. It checks fixed queue prerequisites.
verifyPgBossApplicationPermissions has a separate recovery profile with exact effective
column privileges; the ordinary producer profile rejects the extra permissions.
The full database gate accepts nativeQueueRecovery:true only for the coordinator check;
other roles remain excluded from queue access. Normal startup does not select this flag.

## Evidence

- 53 combined actual-package/PGlite checks pass. The expanded recovery test was also
  rerun after adding recovery under the restricted LOGIN identity.
- Before the candidate grants, canonical recovery fails and the operational job remains
  failed. With the grants, canonical authority + queue recovery + audit succeeds without
  table-wide UPDATE, both under SET ROLE and a restricted coordinator LOGIN.
- Full coordinator database preflight rejects the ordinary queue profile and accepts
  the explicit recovery profile for that LOGIN. The known PGlite TEMP metadata limitation
  is injected; all other identity, schema and privilege checks execute against catalogs.
- Missing data-column permission, extra id-column permission and table-wide UPDATE are
  rejected. Direct job-ID/retry-counter mutation, DELETE and queue retry-policy edits fail.
  The private web role still cannot read queue rows.
- 39 startup regression checks, TypeScript, targeted ESLint and whitespace checks pass.

This is one in-memory engine, not physical production connection isolation or native
PostgreSQL concurrency evidence. No recovery route or automatic reconnect is activated.
Next: propagate the optional recovery command through owned lifecycle and bind recovered
pickup to canonical audit before accepting retryCount > 0. Then authenticate/deduplicate
reconnect-triggered recovery and prove the complete offline-to-review journey.

No acquisitions, credentials, provider calls, persistent services, native database,
VPS changes or GitHub publication. All role mutations occur in disposable test fixtures.
