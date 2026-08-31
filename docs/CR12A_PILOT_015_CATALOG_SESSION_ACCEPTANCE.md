# CR12A-PILOT-015 Protected Catalog and Owner Session Acceptance Record

Status: complete locally for the protected contract and disabled runtime snapshot

Date: 2026-08-31

## Result

Project Workspace no longer treats an application fixture or a caller-supplied identity header as authority for a
protected read. The repository now defines a strict server-side catalog, an independently supplied catalog high-water,
and a verified local owner-session port. Those three facts, plus the existing active owner role grant, are required to
derive the short-lived project read scope used inside one request.

The shipped runtime remains intentionally disabled. No real catalog, high-water store, login, credential, database, or
host was configured or contacted. A later owner-attended local pilot must supply the protected adapters explicitly as
one server-only composition.

## Accepted boundary

- `control-room-project-workspace-catalog/v1` is exact, sorted, tenant-bound, revisioned, digest-bound, and protected by
  an HMAC held outside browser input;
- the expected catalog ID, tenant, and catalog-source identity digest are pinned by the server composition;
- `control-room-project-workspace-catalog-high-water/v1` uses a distinct HMAC key domain and independently binds the
  exact catalog digest, revision, source identity, state, and every project/workspace/type identity;
- catalog revisions are contiguous and chained; rollback, project removal, workspace or type remapping, and resurrection
  after project or whole-catalog revocation fail closed;
- the catalog and high-water must agree exactly before any project identity is returned;
- `control-room-project-workspace-owner-session/v1` carries only normalized proof from a trusted session adapter, has a
  maximum fifteen-minute lifetime, is read-only, and grants no approval, network, command, lease, or execution authority;
- the existing security store must resolve that proof to an active human identity with an active `owner` grant that
  authorizes the exact low-risk, effect-free `project_workspace.read` request;
- the internal read scope is derived only after session, catalog, checkpoint, and policy checks, expires after at most
  sixty seconds, and binds the session, catalog revision, catalog digest, and checkpoint digest;
- read authorization does not create a durable policy-decision row and cannot be satisfied by an operator-only grant;
- the HTTP request supplies only the project path and the opaque Request consumed by the injected session adapter; raw
  identity, tenant, and workspace headers are ignored; and
- the default endpoint returns `protected_identity_boundary_unavailable` until all protected adapters are explicitly
  installed by the later pilot composition.

## Hostile evidence

Focused tests prove refusal of expired or future sessions, cross-tenant sessions, forged subjects and session digests,
inactive owner authority, operator-only substitution, forged catalog or checkpoint HMACs, wrong catalog-source identity,
catalog rollback, project identity substitution, terminal revocation reversal, caller-added scope fields, accessors,
and Proxies. Authentication failure occurs before protected catalog or operator-source reads.

The route tests additionally prove that old caller identity headers cannot activate the default endpoint, the opaque
Request reaches only the session boundary, a valid derived scope returns only the selected project, and missing,
revoked, forbidden, malformed, or unavailable states are mapped to bounded no-store responses.

## Verification

- dedicated CR12A gate: 46/46 passing;
- registered pretests: 769/769 passing;
- core tests: 414/416 passing with zero failures and two intentional platform skips;
- public and CR12A post-tests: 79/79 passing;
- TypeScript check and full lint: passing;
- production build and rendered-route checks: passing, including the protected project API route and 2/2 rendered pages;
- database verification: all 27 migrations and 97 PostgreSQL tables;
- macOS stage zero: `ready_for_runtime_check`; and
- whitespace validation: passing.

## Retained limits

- The repository defines ports and strict contracts; it does not claim that a real local session adapter or protected
  catalog/high-water persistence adapter is configured.
- The in-memory high-water implementation is test-only and cannot be selected for a real pilot.
- Owner role revocation is checked while each request's internal scope is derived. The scope is not returned to the
  browser and lasts no more than sixty seconds; this block does not claim cross-transaction instantaneous revocation.
- The catalog and high-water HMAC keys are separate protected configuration authorities. They must never be accepted
  from a request, committed, logged, reused as session credentials, or substituted for one another.
- No production database or host contact, credential access, live login, protected configuration, project write,
  approval, dispatch, execution, provider call, deployment, DNS, Cloudflare, or external effect occurred.

## Next gate

CR12A-PILOT-020 is one owner-attended local, non-production pilot. It must first freeze an explicit non-production data
profile, a real local owner-session adapter, protected catalog source, and durable high-water adapter. It may exercise
only read behavior and sanitized evidence. Production hosting, production data, writes, and all operational effects
remain out of scope.
