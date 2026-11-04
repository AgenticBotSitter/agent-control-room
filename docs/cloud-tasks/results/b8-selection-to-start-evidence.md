# b8-selection-to-start evidence — PLAN r5 / R3

Specification-only revision on plan/b8-selection-to-start. Previous committed plan: `a53d57ada3ac98147759fcf2a41580431656b451` (r4). Candidate is this file's containing r5 commit; the external R3 selection report records its exact SHA after commit. No self-referential commit identifier or Git configuration change.

Source: `origin/cook/b7-providers` at `412d0c149fe8e272c491900d7a9164f80ecb612a`, inspected read-only from Git objects. Contract reference: **approved B8 selection spec R4**, S1 frozen-binding admission ordering and checker context. Task/playbook are delivery-base documents. NEW/predecessor interfaces remain future contracts.

Review input: HIGH 0 / MEDIUM 2 / LOW 1 for this ID. MEDIUM-1: single timing budget/reserve in §4.2 with nonzero-preparation and shortened-window tests. MEDIUM-2: T12-P preview evidence in U81-A; T12 admission evidence in U81-B. LOW-1: explicit cancellable execution/cleanup/lock deliverable and four-hour implementation allowance within each six-hour continuation. Each finding has a separate revision-history entry; independent re-review of this containing commit is pending. No CLEAN or product gate claimed.

Fixed points read without edits: paid-cap `fba6ae026cbd7be1178df1844e15288caebeb53b`; default-start `3e265a34e87fa9cecdf585e38a7ca0045ce0bc56`. Named-presets and CLEAN all-provider-choice were also compared. Frozen encoder/decoder/merger signatures, override envelope/reset, launcher-only independence, whole-pair priceRowDigest and consumed paid authority remain intact; paid readiness stays false. The saved-selections branch's prior optional third merger argument remains a separate pending correction; this revision retains the fixed two-argument predecessor signature and caller-owned complete route replacement.

Executed `python3 .test-tmp/b8-r3-selection-audit.py` from the parent clone, exit 0: 5 result documents; 43 existing source paths; 17 existing V1 symbols and 16 explicitly NEW/predecessor V1 symbols; 17 existing npm/pnpm scripts and 4 NEW names; 14 explicit filename/line bounds; 73 existing method/interface checks at owning source files. NEW/generated/delivery references are classified separately. Scope, status/fence, whitespace and bounded public-text privacy checks passed.

Executed `python3 .test-tmp/b8-r3-selection-contract-audit.py`, exit 0: 882 timing combinations including preparation/forwarding, shortened/exhausted windows, configured caps and sub-floor allowances; 16 exact-content source anchors plus 21 shorthand source-range bounds; T12-P/T12 ownership, cancellation deliverables, six-hour continuation arithmetic, frozen predecessor signatures and unchanged sibling refs passed. §4.2 is the single timing definition; T12 supplies deciding examples. These are document/source checks, not product behavior tests.

Actual result lines:

- `RESULT R3 selection source audit plans=1 files=5 method_checks=73 fixed_points=unchanged scope_errors=0 whitespace_errors=0 bounded_privacy_matches=0 exit=0`
- `RESULT R3 contract audit timing_cases=882 semantic_anchors=16 shorthand_ranges=21 seams=PASS frozen_signatures=PASS sibling_refs=unchanged exit=0`

Exact final commit and cleanup receipts are recorded in the external R3 selection report and separate progress file. Independent re-review is still required.

NOT RUN: all product/unit/PG17/tools/browser/native/worker/device/Linux/CI lanes; full private-name denylist gate (no list supplied). No network, downloads, package install, credential read, live install/port, model/provider launch or background process. Commands complete in the foreground; disposable-worktree cleanup is recorded externally after commit. Branch retained; no push.

Status: PLAN-READY
