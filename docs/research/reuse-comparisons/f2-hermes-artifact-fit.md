# RC2 Hermes artifact handoff: current supported surfaces

2026-09-08. Source/test inspection only, no Hermes installation/import, dashboard, SSH, file sync, native/provider call or credentials. Pin resolved from public HEAD: [b1f003e18633298d549668b8e186af84cca45b76](https://github.com/NousResearch/hermes-agent/tree/b1f003e18633298d549668b8e186af84cca45b76), commit timestamp2026-09-08T21:57:15Z. This is the observed revision, not a statement about every future HEAD or installed owner's version.

## Outcome

**The run-bound producer-manifest gap remains open. However, Hermes has a real supported artifact receipt/download API that the earlier E08 dashboard-only assessment did not cover.** Keep it as a reusable transport candidate rather than writing another SSH/file-copy engine.

It is `/v1/artifacts/upload` and `/v1/artifacts/download/{artifact_id}`, advertised in the gateway's capability surface and wired to real browser-control artifact storage. It produces content hashes, size, MIME and TTL, but **does not prove which admitted run/job/attempt produced those bytes**. Its storage scope deliberately excludes session ID. This distinction is not a vulnerability allegation: the surface is designed for browser-control handoff under an authenticated principal/profile, not Control Room's multi-project evidence contract.

Current dashboard `/api/fs/download` adds a useful explicit profile/session path resolution seam compared with b499. That fixes choosing the originating session's working directory; it is not a run artifact manifest or an immutable result receipt.

## Actual source and upstream tests

All paths/line numbers below refer to the immutable pin; exact byte lengths, SHA256 and URLs are retained in `f2-hermes-artifact-source-receipt.json`. Sources and tests were inspected, **not executed**. No previous11-fetch/9-policy tests were rerun.

| Surface | Implementation / actual test evidence | What remains missing for CR |
| --- | --- | --- |
| `/v1/runs` status/events | `gateway/platforms/api_server_runs.py:99–105` registers run/start/status/events/approval/steer/stop, no artifact subroute. At542–583 completion carries final_response as output plus usage. Run ownership checks620–650 remain distinct. `test_api_server_runs_extraction.py:161–182` asserts exact run route list; this test filename means module extraction, not file-artifact extraction. | No completed run → artifact ID/hash/size relation or call to remote-media retrieval. This full module is byte-identical to b499, so the old gap is not resolved by a changed run implementation. |
| Receipt API | `gateway/platforms/api_server.py:1505–1509,2255–2261` registers/advertises artifact upload/download.2529–2587 checks browser-control enablement, configured API key/auth, profile/principal and limiter, stores supplied raw body and returns receipt.2589–2612 downloads actual bytes with X-Artifact-Sha256/Id. | Upload authenticates a caller; it does not establish that a task produced the bytes. No run/attempt fields are admitted or linked by this route. It is not automatically the same grant as a scoped run API. |
| Artifact store | `gateway/browser_control_artifacts.py:66–105` receipt has minted ID, SHA256, size, content type/name, timestamps/TTL; scope key is principal+transport family, explicitly not session. Profile isolation is separate per-profile store selection at api_server2474–2507. Store/load validates scope, TTL and checksum; load204–223 consumes before returning to HTTP handler. | No project/job/attempt/run binding, durable receipt index or acknowledged-retry download. Single consume can lose availability if HTTP delivery fails after consumption. Do not assume exactly-once delivery from one-shot semantics. |
| Upstream artifact tests | `tests/gateway/test_browser_control_artifacts.py:429–460` exercises actual aiohttp upload/download bytes/hash and second404 with injected owned store;594–634 checks session-less upload scope composes with session-bearing broker, plus cross-principal/family refusal. Other inspected tests cover tampering, TTL, MIME/size, unknown IDs, feature/auth gate, profiles and orphan cleanup. | These are source-read tests, not fresh passes. They intentionally prove session exclusion; no two-run producer-binding acceptance follows. They use synthetic auth/config/store setup, not deployment authentication qualification. |
| Session-aware file routes | `hermes_cli/web_routers/files.py:691–733` optionally retrieves selected profile session, then resolves path using session cwd. `sessions.py:477–489` resolves session in profile DB. `web_server_files.py:24–45` resolves absolute or cwd-relative paths. | Cwd resolution is not containment: absolute paths remain absolute and parent traversal resolves normally before sensitive checks. No hash/producer receipt; not permission to scrape a path emitted by a model. |
| Upstream session-download regression | `tests/hermes_cli/test_web_server_files.py:137–177` creates same-name files in session and gateway directories; selected session returns correct bytes for relative/absolute/file URI paths; wrong profile/missing session yields404. | Useful profile/session selection evidence, not per-run file ownership or immutability. Existing dashboard login/managed-root grants must not be generalized across `/api/files` and `/api/fs`. |
| Desktop artifact registry | `apps/desktop/src/store/artifacts.ts` versions detected content by session+slug/content hash in UI state, e.g.24–35,111–178. | Display/version convenience, not authenticated gateway producer receipt or canonical CR run evidence. Do not use a UI detection hash as provenance. |

The browser artifact store already existed at b499 with the identical14602-byte SHA256. It is newly identified **in this comparison**, not claimed newly shipped today. Current files.py differs (31377 vs30353bytes); the session-aware path helper and its test provide concrete current behavior. The source ledger preserves prior hashes rather than conflating different pins.

## Durability, limits and transport cautions

Default artifact store limit is10MiB, TTL300seconds; MIME allowlist includes PDF/images/JSON/plain text. These are not current CR native-result limits. Store index is in memory and constructor114–145 sweeps orphan minted-ID/temp files; server restart is not durable artifact recovery. Hash verification protects retrieved byte identity, not producer identity. Browser-control feature flag and configured auth are required; no feature was enabled here.

The upload route uses one `request.content.read(max_bytes+1)` call. This is bounded requested read size, not by itself evidence of a full streamed-body loop or complete-body handling under fragmentation. That would require an actual finite fragmented-body test before selecting transport. No security exploit or runtime failure is asserted from this source observation.

The old E07 remote environment retrieval remains a separate upstream media-delivery capability. This artifact route stores caller-supplied bytes; no inspected run-completion path connects its remote fetch hook to the new receipt. Do not invent that connection by parsing MEDIA text or assuming a desktop artifact card means a remote file arrived.

## Existing CR mapping, without new protocol design

`src/harness/hermes-native-v1/protocol.ts:35–49` validates exact run_id/session_id and parses final output text/usage. It has no artifact-manifest output. `src/artifacts/v1/native-results.ts:41–53` checks actual bytes against hash/size, ≤65536bytes, exact UTF8 and secret-material policy. `bound`103–117 requires durable recorded snapshot and exact node/project/job/attempt/run; `capture`119 onward requires completed signed observation and validates stored-byte readback before canonical receipt persistence.

| Hermes field | Potential reuse | Cannot infer |
| --- | --- | --- |
| artifact_id/download_path | Opaque transport lookup retained by trusted connector | CR artifact identity or ownership |
| sha256/size_bytes | Compare actual downloaded bytes before intake | A permitted producer run emitted those bytes |
| profile/principal/family | Check configured exact gateway context | Project/job/attempt/run separation within that principal |
| expires_at/one_shot | Plan transient transport availability | Durable acceptance, resumable retry or retention after consume |
| session-aware file cwd | Choose correct source location after approved association | Filename belongs to current attempt or returned content matches completed output |

Existing native-result validation/storage can remain the canonical bounded text-result path. Binary/multiple file results are not a drop-in use of its single UTF8 text receipt; do not weaken that contract or synthesize a completed snapshot merely to fit transport metadata. Harness-neutral byte storage and canonical manifests remain reusable once legitimate lineage is provided. PostgreSQL remains global metadata/permission authority, not Hermes cache.

## CR-owned predispatch association is a legitimate alternative

An upstream signed producer manifest is **not a universal new requirement** and its absence does not make handoff impossible. Control Room can legitimately establish the canonical project/job/attempt relationship before execution, retaining the observed native run/session, exact profile and an approved dedicated export root. Whether current deployed admission already supplies every needed part is a root contract question; this report does not invent an authorization mechanism or require Hermes to own CR's canonical IDs.

Concrete existing upstream fields make that alternative assessable: runs.py423–432 selects session_id with explicit/chained/header/fallback precedence and saves session_id with the generated run_id in status. Launch444–451 passes that same session to the agent and captures request_profile. CR readStatus already enforces the native run/session pair. The selected profile/session file route resolves that session's stored cwd, and its upstream regression checks same-name files from different directories and wrong-profile/missing-session refusal. Thus the download interface may provide bytes under an independently known CR association; it need not itself be CR's provenance authority.

Current dashboard auth is still a separate surface: web_server.py382–390 recognizes session header/legacy bearer;623–654 delegates OAuth/token-mode checks and, in ungated mode, requires session authentication for /api requests. The artifact route's gateway API-key proof does not establish dashboard endpoint access. Exact deployed credential/profile scope remains unqualified; no existing secrets were inspected. `/api/fs` uses `_fs_path`, not the managed-files locked-root resolver, so a dedicated export-root policy must be preserved by the admitted connector/root ownership—not inferred from session cwd alone. A predeclared output path and known root are materially different from trusting a path returned in model text.

The next source-to-fixture packet can therefore focus on this existing path: provision synthetic CR predispatch association and dedicated export locations; use actual session/file handlers with synthetic credential/profile configuration; show known-session byte selection, wrong run/project/root refusal at the legitimate CR boundary, changed file/hash handling, and final intake under a real synthetic admitted snapshot. This is a prospective test, not a finding that those CR checks are implemented or that a file copied into a shared directory proves authorship. Keep the upstream manifest extension optional if existing association suffices.

Additional current source read: `hermes_cli/web_server.py`,92358bytes,SHA256 `083f4b1918d82dff613323f77e0b406fdfbc28a281a6f1f1827d57c528c9afe1`, same raw URL prefix and15second deadline as ledger; memory-only, never imported. OAuth/token-auth delegated modules were not audited, so this is auth seam identification rather than full auth validation.

## Smallest decisive follow-up, if assigned

No fresh runtime packet is necessary to establish **absence of run binding in these inspected surfaces**. If root wants to select the supported transport separately, use a disposable actual ArtifactStore/aiohttp route fixture, not installed Hermes:

1. Store two distinct synthetic payloads under the same principal/profile but different simulated runs. Verify actual receipt bytes/hash/TTL and show that native store scope alone does not distinguish run association. No external operation or invented native IDs.
2. Exercise actual one-shot download, checksum mismatch, truncated/fragmented upload, consume-before-response-loss, TTL and recreated-store behavior. Preserve byte availability vs receipt existence distinctions; don't silently retry a consumed ID.
3. Only after root identifies a trustworthy producer-to-run association, feed actual downloaded bounded text into the existing CR intake with an actual admitted/durable synthetic snapshot and verify wrong run/project/attempt, hash mismatch and stale/revoked binding refusal. If association is not available, stop at explicit missing-boundary evidence, not a fabricated receipt or new auth design.

Alternatives: retain proven final text for the current milestone; use existing Hermes byte transport behind an independently admitted export producer; or request a minimal supported upstream run-result receipt extension. A separate SSH implementation, broad dashboard file browser grant, environment credential/file synchronization, or private Hermes fork is not justified by this source comparison. Parent owns which association/extension is acceptable.

## Acquisition / scope

Only public API metadata and raw immutable source bodies were fetched into transient analysis memory with15-second request timeouts. Filtered tree metadata was complete (`truncated:false`); inspected families were run handlers/tests, browser artifact store/broker/API/tests, file/session routes/tests and desktop registry. This is not an exhaustive content search of all Hermes files. No full clone, retained source root, cache, installation or cleanup target was created. Source ledger records every fetched source object and prior-pin comparisons. Disk observation during review showed145487024KiB free; no disk allocation claim relies on this later measurement. Candidate source was never imported/executed.

Pinned root LICENSE is MIT (1070bytes/hash retained), not a dependency-wide or desktop-subtree license clearance. No upstream code or assets are shipped by this report. E1 source/interface/test evidence only; no new E2/E3 result or completed artifact integration. Root review and final choice remain outstanding.
