# RC2 session download: actual handler/response fit

2026-09-08; application baseline2fb66d7; Hermes source pin b1f003e18633298d549668b8e186af84cca45b76. The initial no-install preflight below is preserved; subsequent explicitly expanded preparation produced actual E2 handler/response evidence, not authenticated route or Control Room E3 acceptance.

## Expanded packet result

**Reuse this supported Hermes route as a candidate byte-download transport; do not mistake session-relative resolution for attachment ownership or immutable output.** The unchanged `files.fs_download` and `_fs_download_path`, unchanged `_fs_path`/regular-file/sensitive-name helpers, real Pydantic route models, FastAPI router registration and actual Starlette `FileResponse.__call__` executed. Twelve cases passed their documented behavioral expectations. Some expectations intentionally demonstrate missing containment and mutable files; twelve passes do not mean twelve security protections.

| Actual case | Observed result |
| --- | --- |
| Correct profile/session, relative report.txt, with a competing gateway file | Correct project A bytes, 200 attachment response |
| Second valid profile/session, identical report.txt name | Project B bytes, not project A |
| Absolute and file-URI paths to known file | Correct bytes |
| Wrong profile with absolute path; unknown session; empty session | 404. Wrong-profile/session decisions originate in the synthetic resolver; the original handler calls it before filesystem resolution. Empty session is rejected by the actual helper before resolver invocation. |
| Valid session A with parent path or absolute path into owned project B | Project B bytes, 200. This route does not confine a valid session to its cwd. |
| Synthetic .env file | Actual sensitive-name guard returns 403 |
| File replaced after handler returns, before response streams | Replacement bytes are delivered |
| Same file changed before next download | New bytes are delivered |

The hashes in the research result are computed by the fixture, **not returned by Hermes**. Starlette's actual ETag source hashes mtime/size metadata, not file content. Changed-after-handler is a deterministic observation of the response's deferred open, not a claim about every race or a tested symlink attack.

### Executed boundary and substituted ports

`get_session_detail` is the only replaced Hermes dependency: a two-entry in-memory profile/session→owned-cwd table, with explicit404 for unknown pairs. The real SessionDB, `_with_db`, real user profiles and dashboard authentication do not execute. A local ASGI scope/send sink consumes the actual FileResponse body; no FastAPI request dispatch, listener, socket request or authenticated route is exercised. Selected dependency imports are real, including the native **binary wheel** pydantic-core. No compiler, installation script or native Hermes/provider runs.

Source SHA256 values are enforced before import. Every non-RECORD regular wheel member (314 installed files) is compared byte-for-byte with its verified wheel before imports; unexpected wheel relocation/symlinks are rejected. The fixture excludes runtime site-packages, uses Python `-I -B`, and audits socket connect/bind, subprocess and os.system effects. No dashboard/config module loaded. This is E2 for original handler→real response→owned bytes, not E3 across Control Room's result store, nor E4 remote/deployed access. Upstream `test_download_resolves_paths_in_the_originating_profile_session` at137–177 was inspected and motivated cases; the upstream full test suite was not executed.

### Setup, receipts and resource facts

The earlier missing-framework result was not a candidate failure. The root explicitly expanded installation authority. Actual `pyproject.toml` web extra supplies FastAPI0.133.1, Starlette1.3.1 and python-multipart0.0.32; core supplies Pydantic2.13.4. Binary-only resolver download and an **offline**, no-compile target install succeeded. No aiohttp/uvicorn/full Hermes installation occurred. The complete eleven-wheel closure, exact public artifact URLs, SHA256 and declared license metadata are in `f2-hermes-session-acquisitions.json`; source pin/hash closure includes the original license and upstream test. Direct installed pins and setup/cleanup are recorded in `f2-hermes-session-preparation.json`.

3,049,500 acquired source/wheel bytes; measured owned cohort12,496KiB after installation/fixtures (under50MiB), with no pip cache. Three known retained research roots totaled572,456KiB before this cohort; concurrent root-coordinated work remains separately accounted, comfortably below4GiB. Disk free145,443,332KiB before and145,426,764KiB after the run, both above20GiB. These are disk measurements, **not RAM measurements**. Runtime receipt preserves actual stdout/exit0 for twelve cases and actual framework versions. First run also exited0, but its tool readout was truncated; a second identical run was captured directly to JSON. No failed fixture or focused repair occurred.

Expanded-packet cleanup is complete: exact owned root `/private/tmp/cr-f2-hermes-session.FNPCGw` was removed and absence verified in `f2-hermes-session-preparation.json`. Downloaded source, wheels, isolated target and disposable files are no longer retained; original research scripts and sanitized evidence remain. License expressions/classifiers in the acquisition ledger are declared PyPI version metadata associated with SHA256-verified wheels. Separate wheel METADATA license-file paths/hashes were not retained before cleanup; that shipping-notice work is not claimed complete.

### Integration cost and alternatives

Existing Control Room predispatch contracts already bind canonical task/attempt/session/profile (root `f2-hermes-intake-disposition.md`). Preserve that association and the existing final-response receipt path. This handler could eliminate a separately invented SSH/file-copy transport for dashboard-supported downloads. It cannot eliminate declared export scope, path admission, byte limits, protected endpoint authentication or separate multiple/binary attachment metadata. Current NativeResultStore describes final response text; putting other bytes under that claim would be false evidence. No production module is removed by this experiment.

Relative cost: calling the supported session route needs a narrow transport adapter and independently reviewed attachment intake, without forking Hermes. Copying the full31KB router plus broad schemas into Control Room would unnecessarily bring unrelated upload/media/filesystem operations and framework dependencies; do not recommend that extraction. The gateway's existing browser-control artifact store supplies opaque artifact IDs/hash/TTL, not producer/run binding, and has a different principal/family, one-shot availability and restart scope; it remains an alternative rather than a compulsory second transport. SSH sandbox return and filesystem APIs address other retrieval responsibilities; this packet does not compare authenticated remote availability between them.

Bounded rubric (0–5; not whole-product scores): function fit3 (actual session bytes, not attachment admission); existing-contract fit2 (association available, general attachment claim absent); reuse/maintenance4 (supported pinned route plus relevant test, future compatibility unknown); adaptation cost3 (small byte client, material intake work); license clarity3 (Hermes MIT plus eleven recorded permissive metadata declarations, no shipping-notice closure); evidence3 (actual local handler/response, simulated session authority, no deployed route). No final winner or security acceptance is self-approved.

Required next implementation/qualification is already finite in root's disposition: declared export ownership/containment, cross-project/attempt refusal, changed-byte policy, retained attachment metadata, bounded protected download and result/review linkage. This fixture deliberately does not invent those policies to make negative cases pass.

## Preserved initial no-install preflight

**The existing sterile Python runtime lacks FastAPI and Starlette, so the real selected handler cannot be imported under the no-install scope.** Following the task's explicit stop condition, no replacement APIRouter/FileResponse/HTTPException implementation was written and no framework install attempted. This is an exact setup prerequisite, not rejection of the Hermes interface.

Bundled Python3.12.14 was probed with `-I -B` and importlib.util.find_spec; direct output is preserved in `f2-hermes-session-preflight.json`. Pydantic exists; FastAPI, Starlette, aiohttp and multipart do not. The probe does not execute candidate modules or expose environment/credentials. Repository stagezero separately reports ready_for_runtime_check for Node dependencies; it does not supply Python web frameworks.

## Why this is a real prerequisite

Previously acquired immutable source (memory-only prior packet, unchanged hash) `hermes_cli/web_routers/files.py:24–25` imports APIRouter, File, Form, HTTPException, Request, UploadFile and actual FileResponse from FastAPI. It constructs APIRouter at36 and registers all route decorators at import. It also imports `_subprocess_compat.windows_hide_flags`, `web_deps.late`, `web_server_files` helpers and `web_models` schemas. `web_server_files.py` itself imports FastAPI HTTPException/Request. Merely executing that helper with locally authored stand-ins would repeat E08's policy-only scope, not the newly requested real handler/response fit.

Further controlled preparation would need the exact compatible upstream-declared FastAPI/Starlette versions and closure (including required form-registration dependency when importing the full route module), plus those narrowly imported upstream helper/model sources. Aiohttp is relevant to separate gateway artifact routes, **not required merely because this dashboard route uses FastAPI**. No version guess or broad Hermes installation is proposed. Dependencies should be isolated, pinned, logged and script-disabled under separately expanded packet scope; no production dashboard/profile needs to start.

## Original proposed test (subsequently executed above)

With actual framework dependencies available, invoke the unchanged selected handler/helper against synthetic session/profile resolver and owned export directories. Exercise same-name files under correct selected session, wrong profile/session, absolute/parent resolution, and bytes changed between observations. The session resolver is intentionally a substituted port; framework path/response behavior should not be substituted. Response creation alone is not actual file-byte delivery, so use the real response's bounded local ASGI send path or another explicit actual-response consumption mechanism without a listener, and identify that boundary in evidence.

This does not fabricate CR admission or prove upstream file ownership. Root can map a legitimate predispatch project/job/attempt/run/session/profile/export-root association separately. Current source already shows cwd-relative resolution is not export-root containment, and no returned content hash or immutable file receipt exists in this handler. Retain those facts rather than convert a download into canonical provenance. No new authorization/protocol is designed here.

## Initial preflight acquisition and cleanup

Disk before preparation:145456356KiB free (>20GiB). Zero downloads, zero installed bytes, zero temporary roots or file fixtures. No capacity was consumed against the10MiB acquisition cap and nothing requires deletion. Existing retained sources/roots and all unrelated dirty files were untouched. No provider/native Hermes/SSH/file-sync/profile/credential access, process peer, network listener, app edits or GitHub writes. No failure/repair retry was needed: the dependency preflight stopped before candidate import.
