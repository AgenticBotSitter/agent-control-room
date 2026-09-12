# Current-schema PostgreSQL 17 restore fit

2026-09-08. Local synthetic research. **Overall acceptance FAILS.**
No production configuration, grants, database or application was changed.

## Actual candidate and integration

Use native pg_dump/pg_restore, not custom backup serialization. Signed/notarized
Postgres.app2.9.6 supplies PostgreSQL17.11. Preparation evidence records the
16-file library closure and six version commands. No Applications/PATH install.

`research/reuse-comparisons/f8-pg17-restore-fit.ts` creates an empty cluster with
an owner-only Unix socket, no TCP. It applies all64 actual website migrations and
actual web/database role files, bootstraps a synthetic owner with SecurityStore,
and creates a project with WebProjectService through a restricted login. The
unmodified source preflight passes. A real node-postgres pool uses the actual
bounded database wrapper, not production TCP authentication/private-postgres.

Native whole-database custom-format dump/restore targets another empty database,
preserving ownership/ACLs with single-transaction/exit-on-error. No table filter,
no-owner or no-acl shortcut. The target separately receives the actual database
ACL procedure; cluster roles already exist. This is not cross-cluster role setup.

## Result

See `f8-pg17-restore-evidence.json`:

- All145 public tables compared;11 contain synthetic rows. Row counts/digests,
  relation owners/effective default ACLs and function owners/ACLs match.
- Restored session, role membership, unsafe-privilege and column-permission
  checks pass. **The exact schema-fingerprint gate fails.**
- After retaining that failure, independent measurements show actual project
  listing works; table creation, TEMP creation, role escalation and project DELETE
  are refused. No app starts; final result remains false/exit1.
- Copied synthetic artifact bytes verify; missing/tampered bytes fail. This is
  a local file referenced in a project summary, not canonical native artifact
  intake, off-host backup, or a completed agent result.
- Source unchanged; cluster stopped and exact disposable run removed.

## Concrete Control Room defect

The diagnostic detects one changed manifest entry: the delivery-id CHECK from migration0036.
`BETWEEN 3 AND 160` combined with another AND deparses as `((a AND b) AND c)`
before dump and `(a AND b AND c)` after PostgreSQL reparses the restored SQL.
The conjunctions are equivalent, but our fingerprint hashes their exact text.

- Source digest: `f3431786139ea22bd6f50f5fe06cf518540a469bd49f7222fc8362dffdb7edba`
- Restored digest: `e56870af68cbc06ff07be73fd04588fb7875ab22bc4c65b02f8785b0591e6d5b`

The manifest diff visits restored entries only; it does not independently rule
out a source-only missing index/constraint/trigger. Do not call it an exhaustive
bidirectional schema comparison. The column-permission gate passes before the
fingerprint rejection; the later restored owner-binding gate is not reached.
Successful project reading is narrower than full owner-bootstrap requalification.
The demonstrated textual incompatibility is an application acceptance defect,
not observed row-data loss or excess grants.
Do not disable validation, strip parentheses with regex, accept arbitrary new
digests, or edit the historical migration to make this pass.

## Preserved attempt history

Owned receipts under `/private/tmp/cr-f8-pg17.2FlFtD/`:

1. `restore-evidence-restore-run-Ovihr2.json`: raw NULL versus explicit default
   ACL comparison failed. NULL means PostgreSQL defaults, not no permissions.
2. `restore-evidence-restore-run-BvmQ4q.json`: comparison mistakenly used uppercase
   S (foreign server) instead of lowercase s (sequence) for acldefault; corrected.
3. `restore-evidence-restore-run-3mOreJ.json`: ACL comparison passed, actual
   restored preflight failed without stage diagnostics.
4. `restore-evidence-restore-run-QwLbxs.json`: one detected changed fingerprint entry.
5. `restore-evidence-restore-run-Mtsujr.json`: same failure plus independent
   downstream behavior above; full receipt copied into repository evidence.

All five clusters stopped and were removed. Initial tool preparation also retains
Mac plpgsql suffix and dylib self-identity inspection mistakes; neither required
modifying binaries or bypassing signatures.

## Implementation disposition

Independent review `f8-pg17-restore-review.md` supports the native-tool direction.
Root accepts its report correction above. Four forbidden queries rejected, but
their SQLSTATEs were not individually captured; do not describe these as four
independently diagnosed permission errors. Preparation provenance is staged,
not an immediate executable rehash before every invocation. No whole-cluster
configuration, sequence-current-value or all-object schema equality is claimed.

Retain native logical backup/restore for a dedicated PostgreSQL database. Do not
build a custom backup engine because of this finding. pgBackRest remains a
separate physical/PITR option, not an interchangeable per-database restore tool.

Required work: review a restore-stable schema contract. First evaluate an additive
migration expressing this exact CHECK canonically without changing semantics.
Verify its reviewed digest after migrations, a first restore and a second restore.
If insufficient, separately review structural canonicalization; no generic string
cleanup. Keep negative tests for changed bounds, dropped constraints, excess
grants, missing owner binding and changed row/artifact data. This research does
not authorize a production migration or new production fingerprint.

That concrete fix belongs in A1/D1 implementation, not another backup-product
comparison. Broader acceptance still needs selected agent/task roles, canonical
artifact manifests, separate-role bootstrap, independent backup copy, target
persistence and owner-authorized restore rehearsal. This report is not D1 complete.
