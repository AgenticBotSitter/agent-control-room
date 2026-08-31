# CR12A-PILOT-010 Protected Project Read Acceptance Record

Status: complete locally for the protected read-composition snapshot

Date: 2026-08-31

## Result

Project Workspace now has one protected project-scoped read path over the existing authenticated operator surface. The
server resolves tenant, workspace, and project scope; the browser sends only the selected project identifier. Current,
stale, missing, unauthenticated, malformed, and source-unavailable outcomes remain visibly different from development
fixtures.

The protected panel is present on every shared and project-extension route. It never silently replaces missing protected
truth with fixture data and cannot approve, schedule, dispatch, command, lease, or execute work.

## Implemented boundary

- strict `control-room-project-workspace-read/v1` contract with canonical digest and negative-authority fields;
- server-owned tenant/workspace/project registry matching before a source read;
- a maximum 15-minute authenticated read scope and rejection of future scope time;
- exact adapter over the accepted tenant-scoped operator read service rather than a second database path;
- project-only composition of portfolio, active work, services, schedules, incidents, Action Inbox, and Owner Focus;
- rejection of orphaned related records, cross-project relationships, future source time, hidden fields, accessors, and Proxies;
- current versus stale status using the protected source generation time, with stale data retained and labelled;
- honest `project_not_found` and `protected_source_unavailable` results;
- protected no-store endpoint whose actor, tenant, and workspace scope are never accepted from query input;
- browser-side strict schema, scope, relational, and Web Crypto digest verification; and
- responsive protected-read panel plus a separate explicit development-fixture boundary.

## Verification

- dedicated CR12A gate: 35/35 passing;
- registered pretests: 769/769 passing;
- core tests: 414/416 passing with zero failures and two intentional platform skips;
- public and CR12A post-tests: 68/68 passing;
- TypeScript check and full lint: passing;
- production build: passing with `/api/v1/project-workspace/:projectId` emitted;
- rendered-route checks: 2/2 passing;
- database verification: all 27 migrations and 97 PostgreSQL tables;
- macOS stage zero: `ready_for_runtime_check`;
- desktop and 390-by-844 browser inspection: passing with no page overflow; and
- whitespace validation: passing.

## Boundaries retained

- No production database or host was contacted.
- Repository code cannot prove that the deployment-injected authenticated-user header is unspoofable; PILOT-015 must
  replace that assumption with an exact local owner-session boundary before a data pilot.
- No credential, protected locator, private body, transcript, artifact body, or provider data enters the model.
- The endpoint cannot take tenant or workspace scope from the URL, query, or body.
- The protected model cannot become a fixture and fixture content cannot become protected truth.
- No project write, approval, policy change, schedule mutation, claim, lease, dispatch, execution, or effect was added.

## Remaining gate

The current server-owned project catalog is the clearly synthetic application registry. An owner-attended non-production
pilot must not rely on that registry as deployment identity. CR12A-PILOT-015 will define a protected project catalog and
local owner-session boundary before any owner-attended data-profile rehearsal.
