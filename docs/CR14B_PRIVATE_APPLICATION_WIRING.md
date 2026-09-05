# CR14B B-WIRE — private project application

Date: 2026-09-04. Candidate implementation; independent acceptance is recorded separately.
Base: `962b7cb7078e120ca2070c7aea5c4d71aac70bdc` (PR #280).

## Delivered scope

The VPS profile now builds `private-app/app`, not the preview route tree. It reuses the existing styles and
settled presentation contract. The Sites/local-pilot profile still builds `app`. No dependencies, lockfile,
database migrations, hosting bindings, fixture providers or legacy native drivers are changed.

The private route set is `/projects`, `/projects/{id}`, `/projects/{id}/overview`,
`/projects/{id}/settings`, and `/session`; `/` redirects to `/projects` after authorization.
The root middleware still covers all requests and never falls through to legacy APIs. Unknown routes return
404 after authentication. Before explicit process composition every dynamic route returns the original 503.
Framework static assets contain presentation code, not records or credentials. Private data is not prerendered.
CI now runs the private build/compiled integration checks and also checks architect PRs stacked on `codex/**`.

`dist-vps/server/index.js` is the built request handler. The additional **server-only** `runtime.js` entry
exports the one-time `installPrivateWebProcess` composition. Vite builds both entries in one graph, sharing
the same process instance; the compiled integration test verifies that configuring the runtime changes the
handler and that shutdown closes it. No global browser setter or HTTP configuration endpoint is introduced.
Importing either entry does not read environment values, open a database, fetch keys, seed an owner or start
a listener. A separately reviewed bootstrap must supply exact non-public PostgreSQL configuration, one pool,
issuer/audience/origin, identity/workspace scope and public-key loader, then own listener and process shutdown.

## Authentication, reads and shutdown

- All pages, API requests and finite project snapshot streams use the same Access verifier. Current SQL
  identity, session and permission checks govern every project operation. Ordinary login grants no strong
  factor or effect approval. Manual heads must also match the exact scope-derived manual adapter.
- The process shares a public-key cache, with a maximum five-minute freshness period, a five-second loading
  deadline and fixed five-second backoff measured from failure time. Refresh is demand-driven and single-flight, never caused
  by an unknown JWT key. Expired keys are not a fallback after failure. Key refresh does not shorten stored
  session lifetimes. The optional loader uses only the configured issuer's `/cdn-cgi/access/certs`, omits
  credentials, rejects redirects, and caps response bytes. Only injected test transport is exercised here.
- APIs reject cross-origin mutations, query-selected scope and invalid/oversized bodies. JSON input has an
  8 KiB ceiling and five-second deadline; a stalled reader receives cancellation without indefinite waiting.
  Failure output is fixed and private responses are no-store/noindex. Browser page failures have plain-language
  HTML; APIs never redirect to an interactive login.
- `/session` exposes only generic session-management presentation for a valid assertion, without requiring
  project permissions. Exact-session logout therefore remains accessible after permission or identity loss.
  The browser waits for durable local revocation before navigating to Access logout. Actual IdP logout and
  remembered-session behavior still require the configured edge/owner rehearsal.
  Access logout ends sessions across Access applications, not only Control Room; the session page and recovery
  links disclose this before navigation. Browser API calls send `X-Requested-With: XMLHttpRequest` so an expired
  Access session can return 401 rather than an interactive AJAX redirect. No per-app Access logout is claimed.
- `/api/v1/projects/{id}/events` returns **one finite current-project snapshot** and closes. It is not a
  replayable activity log, live job stream, or promise of indefinite authorization. Every new request checks
  current authority. Subsequent long-lived streams remain separate integration work with periodic rechecks.
- Shutdown stops new admission, waits for active handlers/transactions, then closes the supplied pool once.
  The deployment pool must supply bounded query/connection behavior; no listener, OS signal or real database
  restart/shutdown rehearsal is claimed. A database that never settles can prevent a graceful drain; deployment
  shutdown timeout/reconciliation policy is still required and must not blindly repeat uncertain writes.

## Browser behavior

Catalog and creation components follow the CR14A controlled-prop contract. The architect implemented these
directly while no worker had an accepted claim. CR14B-PROJECT-UI-001 is retained as a retired non-claimable draft;
do not publish it as new work. The three other draft packets remain undispatched.

An authenticated catalog supports creating an ordinary project and opening each project in a normal browser
tab. Overview and Settings are separate pages. Pause, complete, archive and reopen retain canonical audit
and use expected versions. Archive has a separate discoverable catalog section; closing a tab changes no job,
lease or project record. Client callbacks do not create authority or substitute local persistence.

Reads refresh on focus and every 30 seconds while visible; only the newest read can update the view, and writes
invalidate in-flight reads. Authentication/permission/read failures clear displayed records. POSTs are never
automatically retried. An uncertain command retains its exact request/key in the current page instance so an
explicit same-command retry is idempotent; a different command is refused until the owner checks state and
starts a new page. This is not durable pending-command recovery across a browser restart. Fixed error text
does not render raw server details. Navigation intentionally uses document requests, without route prefetch.

## Honest remaining work

This closes the **ordinary-project mounted code path**, not all B-WIRE or the private-pilot exit.

1. Compose the authenticated Idea-project read source and its existing integrity key/owner-only policy; never
   copy Idea projects into manual heads or bypass their event history. Add combined catalog pagination. The
   current private catalog is explicitly ordinary-only and refuses more than 200 records rather than truncating.
2. Integrate protected connection roster and later job/progress/review surfaces. They are not demo fallback pages.
3. Freeze and review the production bootstrap, bounded database pool/role grants, IdP/MFA and ingress setup.
   No bootstrap script, environment secret reader or auto-starting persistent service is introduced here.
4. Perform explicitly authorized Node listener/static/stream/shutdown and owner-attended browser rehearsals,
   real PostgreSQL concurrency/restore checks, and a separately authorized private VPS deployment.

The compiled handler + disposable SQL tests establish mounted server behavior, not browser clicks/hydration,
network TLS, a physical listener, cross-process PostgreSQL locking or a deployed private beta. No browser QA was
requested/run. Build validation uses installed Vite directly without CLI upgrade/prerender behavior.

Primary reference checked 2026-09-04:
[Cloudflare Access assertion validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
[Cloudflare session expiry and logout](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/).
Installed Vinext `appDir`, multi-entry build and middleware code were inspected locally. No upstream code was copied.
