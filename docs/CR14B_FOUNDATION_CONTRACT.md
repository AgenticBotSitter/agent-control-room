# CR14B — runtime, access and ordinary-project foundation

Date: 2026-09-04. Implements ADR-202 under the current completion program. This is repository implementation,
not deployment, an identity-provider setup, real PostgreSQL rehearsal or completion of CR14B's private pilot.

## Implemented boundary

- `build:vps` compiles the installed Vinext 1.0.0-beta.2 with its Node RSC/SSR path into `dist-vps`.
  It uses Vite's builder directly: no CLI dependency upgrade, prerender listener or automatic startup.
  The default build remains Sites/Cloudflare and `.openai/hosting.json` is unchanged. No D1 or R2 authority is added.
- The VPS build embeds an all-route not-configured guard. It cannot fall through to the old preview's fixture
  pages, local code login or forwarded-header endpoints. The build target is fixed in the artifact, not a request.
  `B-WIRE` must replace this guard with the actual authenticated composition; simply deleting it is not acceptance.
- `createAccessVerifier` verifies bounded RS256 application assertions against deployment-selected public keys,
  exact issuer/audience, subject, token type, issued/not-before/expiry times and a maximum seven-day session.
  Configured public-key freshness caps the current verification proof, not the persisted session lifetime;
  refreshing trusted public keys must not force an otherwise-valid browser to sign in again. No token-supplied
  key lookup or network discovery exists.
  Returned identity has no strong-factor/effect approval. Forwarded Sites identity headers are never credentials here.
- `WebProjectService` resolves a pre-existing active human in the existing identity/grant tables on every call.
  It cannot bootstrap an owner. Tenant/workspace are server composition inputs, never browser fields. Catalog/create
  require a workspace-wide matching owner/operator grant; detail and lifecycle require the exact project grant.
  A normal application login cannot satisfy a grant that demands a separate strong factor.
- Session assertion digests (not tokens) are stored in PostgreSQL. The service checks stored expiry/revocation on
  every operation. Logout revokes that exact assertion; a new upstream sign-in can yield a distinct assertion.
  Browser integration still must perform Access logout and handle IdP session behavior. Suspension/revocation must
  retain session rows; deleting them would remove logout evidence and is not the supported recovery procedure.
  Logout is a separate exact-token transaction, not a project permission check: a valid verified caller can revoke
  its own assertion even after identity/grant suspension, expiry or narrowing. It does not revoke another assertion
  or re-enable any identity. Repeating logout is idempotent and preserves the first revocation timestamp.
- A transaction locks the identity, current session and grant rows before a project read/write. Revocations committed
  before admission are observed; an in-flight admitted transaction can finish before a competing revocation commits.
  Token/session and grant deadlines are checked again before commit. No instantaneous revocation promise is made.
- Ordinary projects use existing `projects`, not a parallel catalog database. Migration 0039 adds manual lifecycle
  heads, browser session state and append-only command receipts. Existing Idea Lab lifecycle evidence is untouched.
  Manual heads reference their canonical project; workspace ownership is not duplicated in a second column.
  The initial manual-project list is bounded at 200; it refuses a larger catalog instead of silently truncating.
  The combined manual/Idea-project catalog and pagination are `B-WIRE` integration work.
- Create and lifecycle commands are atomic with canonical audit append and idempotency receipt. A replay with the
  same key/content returns its original result after current authorization; changed content conflicts. Expected
  versions prevent a stale tab overwriting a newer lifecycle. Archive is reversible and never cancels jobs/leases.
- Private project title/summary stay in their canonical records/receipts. Audit metadata contains only logical IDs,
  lifecycle/version and the idempotency key, not arbitrary title/summary or provider credentials.

The application/controller process and its injected dependencies are trusted. These interfaces do not claim to
contain hostile same-process JavaScript or an administrator. CR5C's node ceilings and native effect authority remain
unchanged. The service owns no listener, production connection, provider invocation or node activation.

## HTTP contract

`createProjectHttpHandler` is an executable in-process Web Request -> verifier -> SQL transaction -> Response
composition. It is tested with ephemeral PostgreSQL-compatible PGlite, not mounted against a production database.

| Method and path | Request | Result |
|---|---|---|
| GET `/api/v1/projects` | No query/body scope | `{projects}` for the configured workspace's manual projects |
| GET `/api/v1/projects/{encodedProjectId}` | Exact ID | `{project}` after exact project authorization |
| POST `/api/v1/projects` | `{title,summary}` plus `Idempotency-Key` | 201 new / 200 replay, `{project,replayed}` |
| POST `/api/v1/projects/{encodedProjectId}/lifecycle` | `{lifecycle,expectedVersion}` plus `Idempotency-Key` | 200 result/replay, or 409 conflict |
| POST `/api/v1/session/logout` | Current assertion, exact same-origin request | 204 after exact-token revocation |

All require a verified Access assertion. Mutations additionally require the exact configured HTTPS origin;
cross-site requests are rejected. JSON bodies are bounded at 8 KiB; schemas reject caller-selected scope and
unknown fields. Idempotency keys are 16-100 ASCII letters/digits/underscore/hyphen. Errors are fixed 400/401/403/
404/409/503 JSON codes, never raw SQL or verifier errors; responses are no-store and noindex. No interactive redirect
is returned to an API client. Browser return paths are same-origin paths, not arbitrary redirect targets.

## Remaining integration, before private pilot

1. Review this foundation; freeze database role grants for the new tables under B-DB-PREP. Only disposable local
   tests apply the migration in this block. Production schema changes and privileges are separately scoped.
2. B-WIRE: process-owned PostgreSQL pool and shutdown; configured public-key refresh with bounded stale behavior;
   common page/API/stream identity composition; per-stream expiry/revocation; ordinary login/logout UI; project
   catalog/create/detail/lifecycle UI and worker-result integration. No fake identity or sample-data fallback.
3. Test actual Node startup, static delivery, streaming and graceful shutdown under a separately scoped local
   listener rehearsal. Compiled handler tests are not socket, TLS, VPS or rolling-update evidence.
4. Select/configure the owner's IdP/MFA, private hostname and ingress. Validate real session persistence, revocation,
   logout and origin isolation. No IdP account or MFA enforcement is claimed to be configured now.
5. B-DB-PREP/B-DB-REHEARSE and B-PILOT remain required. Do not label component tests as a deployed private app.

Source reference: [Cloudflare application-assertion validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
checked 2026-09-04. Node build/startup interfaces were inspected in the installed Vinext package, not inferred from
latest upstream support. Exact acceptance evidence is recorded separately after verification and review.
