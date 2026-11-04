# b8-selection-to-start evidence — PLAN r4 / R2A

Specification-only revision on existing plan/b8-selection-to-start. Previous committed plan: `af0ee5be886854232ac1406eb390f3a1fc8d4d1d`. Candidate is this file's containing r4 commit; the external R2A report records the exact new SHA after commit. This avoids a self-referential commit identifier. Prior uncommitted/identity-blocker evidence is superseded; the lead expressly authorizes a per-commit worker identity override and no Git configuration change.

Source: `origin/cook/b7-providers` at `412d0c149fe8e272c491900d7a9164f80ecb612a`, inspected read-only from Git objects. Approved B8 selection spec R4 is the contract reference. Task/playbook are delivery-base documents, not files claimed to exist in the product source tree. NEW/predecessor interfaces remain explicitly future contracts.

Review input: HIGH 0 / MEDIUM 2 / LOW 4. All findings have distinct specification revision-history entries; independent re-review of this containing commit is pending. No CLEAN or product gate claimed.

Changes: Removed slot byte caps; bounded cancellable exact-candidate admission checker; hypothetical previewSaved intent; caller providerRoute assembly with unchanged codec/merger signatures; recorded approved-spec preview-name amendment/tools mapping; committed provenance.

Fixed points inspected without edits: `plan/b8-paid-cap-mechanism` at `fba6ae026cbd7be1178df1844e15288caebeb53b`; `plan/b8-default-start` at `3e265a34e87fa9cecdf585e38a7ca0045ce0bc56`. No contradictory contract change identified: the shared encoder/merger signatures, product override names and false reset, launcher-only independence and whole-pair paid digest remain intact.

Current deciding checks: `python3 .test-tmp/b8-r2a-audit.py` from the parent clone audits both plans' current source references and function/script inventories against the pinned source, distinguishes NEW/generated/delivery references, checks citation bounds, allowed result paths, code fences, whitespace and bounded public text. Its actual result is recorded below; the external report/progress additionally carries commit and cleanup evidence. Final commit and cleanup commands/results are also recorded there. Documentation checks do not qualify runtime behavior.

Executed: `python3 .test-tmp/b8-r2a-audit.py` from the parent clone, exit 0. This plan: 5 result files, 43 existing pinned-source paths, 17 existing V1 symbols, 16 explicitly NEW/predecessor V1 symbols, 17 existing npm/pnpm script names and 4 NEW names; 14 explicit filename/line anchors within source bounds. The combined inventory additionally checks 73 existing method/interface references at their owning source files. Missing NEW paths/symbols are not asserted to exist on the source base.

Actual final line: `RESULT R2A audit plans=2 files=10 method_checks=73 fixed_points=unchanged scope_errors=0 whitespace_errors=0 bounded_privacy_matches=0 exit=0`.

Initial audit-harness runs exposed an unused manifest entry, a helper export assigned to its consumer instead of its definition, and the generic script placeholder X; corrected the audit inventory to the actual source definitions/placeholder classification. These were audit-harness failures, not product test results. No production code changed to obtain a pass.

NOT RUN: all product/unit/PG17/tools/browser/native/worker/device/Linux/CI lanes; full private-name denylist gate (no list supplied). Historical cloud setup/install/PG acquisition checks were not rerun and are not current-machine evidence. No network, downloads, package install, credential read, live install/port, model/provider launch or background process. All owned commands completed in the foreground. Disposable worktree removed only after successful commit and clean checks; plan branch retained; no push.

Status: PLAN-READY
