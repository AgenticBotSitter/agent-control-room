# CR12B-IDEA-040 acceptance — protected Idea Lab operator workflow

**Status:** Complete locally for the authenticated, repository-fake, provider-disabled implementation snapshot.
**Date:** 2026-08-31
**Authority:** This record accepts repository code and local synthetic evidence only. It grants no native provider contact, credential access, production database access, deployment, or automatic project creation.

## Delivered

- A protected operator service accepts exact create, start, cancel, and synthesize commands only after the existing owner-session boundary has authenticated the request.
- Tenant, workspace, creator identity, panel identities, session ID, run ID, policy decision IDs, and provider evidence are derived on the server. None is accepted from the browser.
- Every operation requires an active human owner grant for its exact low-risk, no-external-effect action. Agent and operator identities cannot substitute for the owner.
- Session creation, panel execution, cancellation, synthesis, and the already-protected owner decision remain distinct recorded steps.
- The only accepted panel driver is the deterministic repository fake. The projection always reports that no live provider is configured or contacted.
- Start and synthesis commands absorb exact replay without repeating provider work or durable synthesis. A pre-evidence cancellation is durable and prevents a later panel call.
- Synthesis is computed from the complete retained contribution set. It remains advisory and cannot promote a project.
- Four protected HTTP routes authenticate before parsing command bodies, bind the session identifier from the route, reject caller aliases, enforce bounded JSON bytes and media type, and return safe errors with no-store caching.
- The Idea Lab page now presents separate controls for create, run, synthesize, cancel, save, and owner promotion. In the shipped composition they are visibly disabled because no protected runtime is configured.

## Safety invariants

1. A browser cannot select tenant, workspace, creator, panel membership, provider mode, policy identity, or authorization evidence.
2. Every write-capable operator command is authenticated and authorized for a current human owner before the service action.
3. Live Hermes, Codex, local-model, or other provider drivers are rejected by this composition.
4. Provider advice grants no approval, command, lease, execution, or project-creation authority.
5. A project is created only by the separate exact owner-decision service and its pre-existing immutable permit.
6. An unknown post-provider-marker outcome is terminally ambiguous and is never automatically retried.
7. Request bodies are read with a real byte ceiling even when no trustworthy content-length header is supplied.
8. The default HTTP runtime and browser controls fail closed.

## Local evidence

- Eleven new CR12B-IDEA-040 tests cover the complete create-to-project flow, exact replay, durable cancellation, stale and early commands, human-owner enforcement, default-closed routes, authentication order, route-derived scope, body limits, and disabled/enabled control states.
- The combined CR12B gate passes 37/37.
- Registered pretests pass 769/769; the core suite reports 414/416 with zero failures and two intentional platform skips; registered posttests pass 116/116.
- TypeScript, full lint, production build, rendered-route checks, all 29 migrations with 104 PostgreSQL tables, macOS stage zero, and whitespace validation pass.

## Deliberate limits

- No live provider, native Hermes profile, provider credential, production runtime, or owner-session adapter is configured or contacted.
- The shipped page cannot enable its protected controls; it honestly reports the missing runtime rather than falling back to fixture authority.
- Cancellation is accepted only before provider evidence begins. Once an invocation marker exists, the coordinator's terminal no-retry rules govern recovery.
- The browser does not yet have an owner-scoped session catalog or reload-safe session resume. Project lifecycle transitions also remain server-store operations without protected browser endpoints.
- No production PostgreSQL service, VPS, deployment, DNS, Cloudflare, or public hosting was contacted or changed.

## Next gate

CR12B-IDEA-050 adds an owner-scoped durable session catalog, reload-safe resume/status reads, and protected reversible project lifecycle controls. It must preserve the same server-derived scope, owner-only write boundary, exact transition graph, and disabled live-provider composition.
