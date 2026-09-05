# CR14B exact setup/rehearsal packet — DRAFT, NOT AUTHORIZED TO RUN

Date: 2026-09-04. Architect: Codex, Astra Xhigh. This is a scoped execution specification, not a dispatch,
approval, ready claim or executable setup tool. The listener/static adapter is now independently accepted
in `CR14B_PRIVATE_SERVING_ACCEPTANCE.md`. The SQL/application rehearsal tooling is now implemented as a
reviewed implementation in `CR14B_DATABASE_REHEARSAL_ACCEPTANCE.md`; no native run is authorized. Its explicit
pool-reopen, cleanup and non-exercised listener/restore labels narrow what this portion can prove. Stop until
the exact artifacts, remaining operator composition and permission packet have passed the required review.

## Separate setup from rehearsal

1. **B-DB-PREP:** owner selects the exact VPS/private network, a dedicated disposable database name, distinct
   migrator and web login, PG17 patch/package digest, approved backup destination, and a bounded maintenance
   window. Store actual identifiers/credentials only in a private operator packet. Explicitly approve installs,
   service creation/start and DB/role changes needed on that host; none are implied here. No RDS, public listener,
   DNS, production data, existing-agent credentials or provider calls. Confirm the app and DB are on the same
   host for this profile; a Tailscale address is not accepted as a replacement for loopback.
2. **B-DB-REHEARSE:** after setup and reviewed harness readiness, authorize one disposable run of at most
   15 minutes using at most eight web connections plus two operator validation sessions. Use synthetic owner,
   workspace/projects and fixed request keys. No real enrollment, provider, MCP/plugin or production records.
3. **B-PILOT:** later, separately select IdP/MFA/private hostname/Access and approve actual browser/login/ingress
   and deployment. A hidden name is not a security control. A work-domain alias requires employer approval.

## Required immutable packet fields before execution

Record repository commit + tree, compiled artifact digest, reviewed harness entry/command, exact approved
disposable host/database/login references, PG17 version/artifact digest, owner approval reference, allowed
time/effect budget, and exact cleanup targets. No wildcard database/role cleanup or placeholders may execute.
If any field is absent, output `setup_incomplete` and make **zero** connection/listener/setup attempts.
No credential goes in the command line, GitHub, logs or retained evidence; the operator supplies it privately.

## Operator-controlled preparation in the disposable database

- Apply the reviewed migrations 0001–0044 as the separate migrator. Do not auto-migrate from web startup.
  CR14C's task proposal schema and restricted-role insert guards require a newly prepared packet; older
  schema fingerprints/preparation packets are not reusable. No real database has been migrated by this change.
- Apply the exact reviewed `private_web_roles.sql` fresh-role profile and `private_web_database.sql` database
  ACL profile as the authorized administrator. Their PUBLIC/default-privilege changes require a dedicated DB.
- Create the private web LOGIN with only `control_room_private_web` membership, no ADMIN option, no ownership,
  no elevated attributes. Verify all migrator roles' future default grants; web startup must reject drift.
- After separate host/DB/migration/role setup, use the accepted `CR14B_FIXTURE_PREPARATION_CONTRACT.md`
  entry under its exact owner packet to populate the still-empty disposable DB in one transaction. It uses
  the separate migrator, not the ordinary web role. Retrieve its fresh synthetic material once in memory
  and pass it directly to the rehearsal; record the preparation digest only after that prerequisite exists.
  Do not manually prepopulate tables, log keys or treat fixture completion as acceptance of real setup.
- Confirm DB ingress denies Internet access, local-only endpoint, private authentication and owner-controlled
  credential delivery. Retain pass/fail references, not addresses, subjects, passwords or raw host diagnostics.

## One rehearsal, no automatic repair/retry

The later reviewed runner must execute this exact bounded sequence and retain fixed outcomes/counts only:

1. Read-only preflight succeeds on the approved role/schema/settings and rejects a separately declared
   unsuitable fixture profile. Capture pass/fail and reviewed schema digest, never raw catalog/row dumps.
2. Create/read/lifecycle/replay one synthetic project; read synthetic Idea/connection evidence; verify two
   immutable command/audit receipts and no repeated effect for the same request key.
3. Revoke the synthetic assertion, confirm project/connection reads deny it and the tombstone remains. Confirm
   harmless locking works while identity/grant/enrollment writes and session expiry changes are denied.
4. Use the two declared independent sessions to demonstrate lock serialization and 2-second lock timeout.
   Exercise 5-second statement, 10-second transaction/5-second idle limits and eight-operation/no-queue admission.
   Use bounded inert delay/lock fixtures, not production records or repeated failure loops.
5. Close while a bounded handler is active: reject new admission, observe drain and exactly-once pool close.
   In a separately named injected-failure case, require uncertain status and no automatic command replay.
6. Only after the listener/static adapter is reviewed and explicitly included in the same permission packet:
   one loopback-only listener, one synthetic request sequence, fixed built client assets only. Verify no server
   chunks/config/source/directory listing can be served. Close and prove listener/DB-session absence. This
   step remains **not authorized/runnable as a rehearsal** until the real-PG harness and exact permission
   packet exist; use the accepted serving entry, never an improvised listener command.
7. Reopen once under the same bounded authorized rehearsal solely to reconcile stored receipts and demonstrate
   persistence. This is a planned restart, not an uncertain-operation retry. Restore a disposable backup into
   the separately named restore target only if that target/action is explicitly included; otherwise report
   restore not exercised. Full backup/rolling-update acceptance remains CR14G.

Stop immediately after an unexpected host, role, schema, cancellation/close failure or uncertain write. Do not
repair the harness or authorize yourself a second run. Preserve fixed failure status and request-key reference
for owner/architect reconciliation. No raw errors, SQL data, connection strings or native output retained.

## Exact cleanup and disposition

Always stop only the disposable listener/session resources this packet started; close declared connections.
Remove only explicitly named synthetic DB/restore DB and test logins/groups created by this packet under its
cleanup approval. Never remove an existing shared role, data directory or production service. Verify absence of
those exact resources and restore any separately approved host changes. Cleanup uncertainty blocks acceptance.
Keep only commit/tree/artifact/version digests, time/effect counts, per-check outcomes, cleanup absence and
the sanitized disposition. Do not claim real beta readiness from PGlite, an injected TEMP result or this draft.
