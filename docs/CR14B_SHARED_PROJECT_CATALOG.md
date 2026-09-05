# CR14B — shared private project catalog

Date: 2026-09-04. Candidate repository implementation on Astra Xhigh.
Base: `59373732f659096fbcf6703fb33848be164bd46e` (PR #281).

## User outcome and scope

Ordinary and Idea-promoted projects can now appear in one private catalog and open their own Overview and
Settings pages. Each card identifies its origin. Both retain archived history. The catalog loads at most
50 projects per page instead of failing when the workspace exceeds 200 projects. Normal document links
support separate tabs, first/next pages and browser Back; closing a page never changes a project or job.

This block connects **existing Idea-project reads**, not real bot conversations, Idea promotion or Idea status
commands in the private application. Idea status is visibly read-only here; it continues to come from the
existing registry. Ordinary commands and their current authorization remain unchanged. No additional database,
manual head for an Idea project, copied catalog or fake fallback is introduced.

## Authorization and integrity

| Operation/source | Required current authority | Behavior |
|---|---|---|
| Ordinary catalog source | Matching human owner/operator `projects.read` with wildcard project scope | Only configured tenant/workspace/manual-adapter projects |
| Idea catalog source | Matching human **owner** `idea_lab.project_read` with wildcard project scope | Only configured tenant/workspace/Idea-adapter projects, with verified registry projection |
| Detail or finite snapshot | The source-specific read action for the exact project; Idea still requires owner role | Does not grant catalog enumeration or command permission |
| Ordinary create/lifecycle | Existing `projects.create` / `projects.lifecycle` checks | UI permissions are hints; POST is independently authorized |
| Idea lifecycle | Not exposed by this block | Ordinary lifecycle endpoint cannot adopt an Idea project, including one with an invalid manual head |

The web service resolves and locks the active human, exact stored session and current grants once in its
transaction. Each source actually included and each returned record registers its own policy check; token,
session and all required grant deadlines are rechecked before commit. An operator grant cannot satisfy an
owner-only Idea read even if its action list is a wildcard. Per-project read grants allow exact detail reads,
not workspace enumeration. No session assertion creates an identity or proves a strong effect approval.
Direct reads determine source eligibility from the current grants before resolving the requested ID. The
lookup filters out unauthorized sources, so a hidden Idea/ordinary record and an absent record return the
same 404 response. A caller with neither source's exact read permission receives 403 without resolving the ID.
This response-shape rule applies to API, HTML and finite snapshots; it is not a timing-side-channel proof.

`IdeaLabProjectRegistryStoreV1.getProjectInSession` is a read-only composition method. It locks the exact
tenant/workspace/project/adapter row inside the caller's already authorized transaction, then reuses the
existing latest-event authentication and canonical mirror/snapshot verification. It creates no transaction,
policy, key, lifecycle event or project record. It does not newly claim full historical chain/rollback proof.
Current Idea mutations commit the mirror and event atomically; a shared read holds the project row stable.

The server-owned process optionally receives `ideaProjects.integrityKey` from its future reviewed bootstrap.
This must be the existing private registry key; this block never reads or creates one. The registry copies it
at construction. Missing composition is reported as `not_configured`, not an empty successful Idea source;
an Idea-only reader without configuration receives unavailable. A wrong key or inconsistent projection makes
the requested read/page unavailable with a fixed error. There is no fallback to raw project title/state.
Tests supply synthetic material only. Production custody, rotation and setup remain separate work.

## Paginated HTTP and browser contract

GET `/api/v1/projects` returns `{projects,nextCursor,canCreate,sources}`. The sole optional query parameter
is `after`, occurring once, with the exact returned logical ID. Each view adds `origin` (`ordinary` or
`idea_lab`) and `lifecycleEditable`. These fields are server-derived. Existing project commands still return
their ordinary-project receipt shape; detail and finite snapshot endpoints return the shared read view.

The SQL selects at most 51 canonical IDs under the authorized source filters. It returns verified views for
the first 50 and a continuation only when another row exists. Sorting and the exclusive `after` comparison
use PostgreSQL `COLLATE "C"`; the safe ASCII logical ID alphabet also has that order in the browser. The
cursor is a navigation position, **not a credential, signed snapshot or grant**. A caller can choose a position
but cannot change scope, sources or authority. Every page is reauthorized; previous-page access is not reused.
Unknown/duplicate parameters, empty/invalid cursors and scope selectors are rejected.

Pagination is a fresh read, not one frozen catalog snapshot: later inserts at or before the cursor appear
when returning to the first page, and access changes can remove projects from subsequent pages. Records are
not retained across pages. Poll/focus refresh updates the current page only. The UI labels archived groups
as page-local, never claims that a denied or unconfigured source has no projects, and does not show an allowed
create control until the catalog's permissions arrive. Invalid/nonprogressing client page data is unavailable.
No automatic POST replay or additional live stream is added.

The old internal ordinary-only `list` compatibility method remains bounded; the mounted private catalog uses
`listPage`. This wire change ships with its browser bundle in the same currently undeployed artifact; it is
not a claim of independently rolling deployed old/new clients. Deployment version compatibility remains gated.

## Verification and remaining work

Required evidence: mixed source reads with real disposable SQL; catalogs beyond 200 records without duplicate
or missing IDs; tenant/workspace and owner-role isolation; scoped/expired/revoked grants; missing/wrong key and
inconsistent snapshot behavior; preservation of existing Idea lifecycle history; refusal of ordinary commands
for Idea records; strict pagination inputs and safe client navigation; and the actual compiled route handler.
Retain exact test results and independent review in the acceptance record after the candidate is frozen.

No browser clicks/hydration, physical listener/static serving, production PostgreSQL, provider/agent call,
credential-store access, host service, migration, dependency installation, Sites publication or VPS deployment
is authorized or performed here. The preview remains separate. Private connection presentation, deployment
bootstrap/roles/IdP/MFA, real database/listener/browser rehearsals and private-pilot acceptance remain B-WIRE/
B-DB/B-PILOT work. Live Idea conversations and private Idea commands remain CR14E integration work.
