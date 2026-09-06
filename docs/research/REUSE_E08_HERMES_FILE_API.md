# E08 — Hermes file API selection and permission fit

Date: 2026-09-06; Control Room baseline `bc7429f`. Pinned Hermes merge
`b499ab11fe8b081470e269f2fb27abae03000da5`, same as E07. Source/license provenance
is in [the ledger](../REUSE_DOWNLOAD_LOG.md). No installation or live HTTP request.

## Decision

**Keep Hermes native remote-output retrieval; do not activate its broad dashboard
file browser as Control Room's artifact API.** Existing read/download endpoints may
be reused behind a restricted connector if a trustworthy run-to-file binding is
established. Source research has not established that binding. This is an integration
gap, not a claim that Hermes's owner-operated dashboard is insecure for its intended use.

Do not add a new SSH copy engine or import Hermes filesystem synchronization. Continue
the first text-result task milestone and other selected reuse integrations; richer
file results remain an explicit unfinished outcome, not removed from scope.

## Exact existing interfaces

| Pinned source | What it supplies | What it does not prove |
|---|---|---|
| `hermes_cli/web_routers/files.py::get_media`, `/api/media?path=…` | Base64 image response limited to resolved image/screenshot/cache roots; image-extension allowlist and 25 MiB limit. | Arbitrary PDF/guide download, run ownership or remote-sandbox fetching. Reads a gateway-local file. |
| Same module, `/api/files/read`, `/api/files/download`, `/api/files/stream` | Managed-root file reading/download and media streaming; sensitive-path checks, size checks and existing FileResponse serving. | Canonical Control Room project/task/attempt isolation. These paths are not `/v1/runs`. |
| `hermes_cli/web_server_files.py` | `HERMES_DASHBOARD_FILES_ROOT` optionally locks the managed file browser to one canonical folder. | A per-project or per-request root. Without the setting (outside the hosted-root case), home is a starting location, not a containment boundary. |
| `hermes_cli/web_server.py` | Dashboard session header/bearer authentication, OAuth gate and an opt-in token-auth seam; download alone also accepts query token. | Permission to hand the dashboard's credentials to a worker/browser or assume native run credentials are interchangeable. Other auth modules were not audited here. |
| `tools/environments/file_sync.py` | Hermes environment synchronization, including credential/skill/cache paths. | A project-result transfer service. **Not selected**: its responsibility is materially broader than our artifact handoff. |

Dashboard file downloads use request-global policy; the inspected routes do not accept
a run/attempt identity or enter an explicit profile scope. The separate image upload
route does accept a profile; do not generalize that behavior to file downloads.

The dashboard server module was read only, not imported: it assembles an application
and creates session authentication state. Existing credentials and installed Hermes
state were not read. No token URLs were generated or used. A future connector must
keep credentials out of URLs and browser-visible output, preserve exact endpoint/
profile identity, and reject redirects unless explicitly covered by the contract.

## Source-level test evidence

Ran `scripts/research/hermes-managed-files-policy-evaluation.py` with bundled Python
3.12.14, `-I -B`, source directory `/private/tmp/cr-e06.QqqVyy`. Nine tests passed:

1. Locked-root relative file resolves.
2. Locked-root absolute file resolves.
3. Outside absolute file is denied.
4. Parent traversal is denied.
5. Synthetic symlink escaping the root is denied.
6. A sibling directory sharing the root's name prefix is denied.
7. Missing file and NUL-containing path are denied.
8. Unlocked default permits a synthetic file outside its default home.
9. Changing a synthetic request's project ID does not change file access.

The last two checks deliberately preserve the limits, not product acceptance. FastAPI
is absent from the bundled environment (confirmed by an import probe). The test uses
stand-ins only for its HTTPException/Request types and loads the complete pinned path
policy unchanged after hash verification. It tests filesystem resolution, **not actual
HTTP, authentication, FastAPI behavior, byte streaming or the route's sensitive-file
filter**. No package was installed to hide this limitation. The owner's home was never
used: the default-home test substitutes a synthetic directory. Temporary files and
symlinks were removed by test cleanup; downloaded source remains retained.

## Smallest justified bridge and acceptance

The remaining custom responsibility is the canonical association and authorization,
not file transfer. A Control Room result must name the producer's admitted run/attempt,
carry actual verified bytes/size/hash, and remain available to the permitted project
after gateway cache cleanup. A model-emitted path or successful HTTP response alone
does not establish that relationship.

Before a file bridge is wired:

- Find an existing native producer receipt/manifest or supported run-scoped handoff;
  if absent, document the precise missing interface for a minimal upstream change.
- Test an approved dedicated export root with exact-profile credentials and no extra
  dashboard write capabilities exposed to workers. Root containment is only one check.
- Exercise same-name files in two projects, another run's path, revocation, redirects,
  partial download and cache expiry; no wrong-project file may become review evidence.
- Retrieve via upstream transport/HTTP primitives, retain through approved local/R2
  storage, and keep PostgreSQL as the only canonical metadata/permission authority.
- Prove the website download and a Codex recipient work without Hermes dashboard
  access. Live host activation still needs its own scoped authorization.

E07's 11 transport tests plus E08's nine policy tests are separate evidence, not 20
end-to-end fleet tests. No production dependency, connector, authentication change or
runtime integration was introduced by this assessment.
