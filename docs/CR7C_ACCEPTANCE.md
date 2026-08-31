# CR-7C acceptance — northbound MCP

**Status:** Accepted for effect-free repository implementation. Deployment and native/network proof remain separate blocked gates.

## Delivered

- MCP `2026-07-28` stateless request and discovery contract.
- Ed25519 signed, audience-bound, short-lived grants bound to opaque bearer possession.
- Per-request scope, tenant, project, expiry, monotonic-clock, replay, redaction, and exact-envelope enforcement.
- Scoped portfolio, fleet, active-work, attention, request, job, and artifact-evidence reads.
- Proposal-only job, delegation, and approval-request tools with explicit zero authority and zero dispatch.
- Durable private SQLite replay and proposal state with restart recovery, exact schema verification, row-integrity verification, bounded capacity, and internal accept/reject review state.
- Typed client using `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name`, with private authentication and strict result validation.
- Synthetic end-to-end: typed client proposal, durable internal policy review, real synthetic execution, terminal job observation, verified artifact evidence observation, and no MCP-created dispatch.

## Adversarial acceptance cases

The focused suite proves:

- missing, wrong, forged, expired, and rollback-time authentication fail closed;
- tool discovery cannot reveal tools outside the signed scopes;
- malformed envelopes and header/body disagreement execute nothing;
- cross-project reads and proposals are denied;
- hidden project rows do not leak through truncation metadata;
- exact replay is stable while changed reuse conflicts;
- idempotency survives a new request and later server timestamp;
- expanded or detached delegation fails without recording;
- approval request expiry is clamped to the caller grant;
- bearer-like canaries are never echoed or stored;
- expiry is rechecked before proposal mutation;
- restart removes abandoned claims without duplicating proposals;
- added SQLite triggers and altered replay/proposal rows fail closed;
- typed clients reject malformed or secret-bearing output; and
- the synthetic proposal-to-result loop yields only scoped, redacted job and artifact facts.

## Evidence

Run:

```text
npm run check
npm run lint -- --quiet
npm run test:cr7c
npm test
npm run test:build
npm run db:verify
```

The focused result is 19 passed, 0 failed, 0 skipped. `npm test` runs that gate first, then the existing 413-test repository suite: 411 passed, 0 failed, and 2 platform-specific tests skipped. Type checking and full lint pass. The production build and both rendered-route tests pass. Database verification applies migrations through `0020` and verifies 68 PostgreSQL tables.

## Residual gates

- No HTTP/network transport, OAuth authorization server, TLS configuration, reverse proxy, native client, service installation, or deployment was exercised.
- The access-grant issuer and its rotation/revocation operating procedure still require a deployment design.
- Production proposal materialization must enter the canonical workflow transaction and authority gates; the MCP store cannot dispatch.
- CR-7D public adapter SDK, CR-7E procedure/knowledge registry, and CR-7Q independent harness/MCP security review remain later blocks.
- All work remains local under the owner-requested GitHub hold through 2026-09-01.
