# CR14A — private-beta integration direction

**Date:** 2026-09-04

**Disposition:** Architect-authored repository design; implementation and live evidence remain separate.

**Authority:** ADR-202, the current completion program, and unchanged `CR5C_FINAL_SECURITY_CONTRACT.md`.

## Decision and limits

Keep one project-neutral modular monolith, one private PostgreSQL global write authority on the Hostinger
VPS, per-node local ceilings, canonical job/attempt/evidence/review records, and separate human approval for
consequential effects. PGlite remains development/test-only; R2 holds approved artifacts/backups, not claims.

The correction is delivery order and integration approach, not permission to enable dormant code. Existing
CR12/CR13 native-qualification failures, exact runtime pins, effect ledgers and reviews remain unchanged.
CR13A-LIVE-000 through LIVE-500 are retained as historical/component evidence; their continuation is no
longer the default critical path. No exported factory, listener, native source or disabled runtime is wired here.

The first beta supports a bounded owner-managed fleet. The existing CR5C exclusion for an already-compromised
same-OS-identity process or an administrator remains explicit. Keep untrusted harness/tool code outside the
trusted controller process; use declared OS/service isolation. Do not claim object branding or captured JavaScript
intrinsics provide an OS security boundary. A compromised server still must not widen a node's owner-set ceiling.
Existing runtime restrictions stay enforced until a separately reviewed replacement is actually implemented.

## Selected connection topology

| Boundary | Owner and selected responsibility |
|---|---|
| Browser -> private web application | Human authentication and project-scoped operations; browser never holds node or provider keys |
| Control Room -> PostgreSQL | Same-VPS/private-network transactional authority; no public database listener |
| Node connector -> Control Room | Outbound authenticated HTTPS with the existing signed job/lease protocol, local journal and individual revocable identity |
| Node connector -> Hermes | Thin adapter to an explicitly enrolled native Hermes run API; only after local authority intersection and effect admission |
| Node connector -> Codex | Separate supported Codex lifecycle adapter under the same canonical job model, not shared Hermes credentials |
| Agent/client -> MCP | Scoped tools over the same application services; not a new scheduler, database or permission system |
| SSH / Tailscale | Administration or authenticated network reachability only; neither creates application authority |

A Mac or PC can host both Hermes and Codex. One node connector can host distinct adapter registrations with
separate profile/session/run identities, credentials and capacity. They coordinate project work through the
canonical queue, not by sharing a live Git checkout or modifying each other's state directories.
VPS Hermes does not require a Codex installation. Each host/harness route earns its own explicit supported status.

### Hermes interface selection

Prefer the native run API over the custom Control Room loopback protocol. The official `v2026.8.31` release
resolves to source commit `29112bef099274229cadff79cdff7bf7b99c4b77`. Its source defines run start,
status, events and exact-ID stop, plus capability reporting for durable idempotency. Its Bot Mode/peer
implementation offers desktop-independent messaging. See `CR14A_UPSTREAM_REUSE.md` for exact sources.

This is a **candidate interface/source pin**, not a selected installed runtime, an upgrade/downgrade instruction,
or accepted compatibility evidence. The previously reviewed `a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b`
pin and empty/disabled accepted-runtime lists are not changed by this document.

The C-ADAPTER block must freeze and verify the complete boundary in one coherent implementation batch:

- Exact enrolled gateway/profile/session identity and allowed run operations; no caller-supplied URL,
  unrestricted RPC proxy, arbitrary profile inventory, raw credentials or personal-profile cloning.
- Exact run ownership, normalized terminal states, usage truth, bounded events, stale/offline behavior,
  and cancellation that targets the admitted run only. A stop acknowledgement is not proof work has stopped.
- Durable idempotency support and retention are observed capabilities, not inferred from an endpoint name.
  Upstream idempotency supplements, never replaces, the node pre-effect marker and canonical attempt ledger.
- Reconnection first reconciles the existing run; an unknown outcome after possible dispatch becomes
  ambiguous and is never automatically resubmitted. Event replay support must be measured; use an explicit
  status resnapshot if replay is unavailable. Do not promise exactly-once external execution.
- Preserve project/session context isolation, local ceilings, deadlines, tool restrictions and measurable budgets.
  Personal authentication availability does not authorize using every inherited skill/tool/MCP server/plugin.
- Use the existing HTTPS destination/identity requirements for the enrolled gateway. If an upstream gateway
  requires a service-private HTTP hop, its TLS termination and process/network isolation need an explicit
  narrow adapter/deployment contract before use. This document introduces no plaintext or generic TCP exception.
- No direct public Hermes exposure. Prefer existing supported native interfaces; no core fork, runtime patch,
  native listener qualification or installation is justified merely by this design selection.

If the candidate cannot meet those constraints, report the specific missing capability and alternatives in
C-ADAPTER. Do not invent replacement authority envelopes, silently enable an old driver, or resume the entire
custom-listener program automatically. A fallback decision requires a concrete compatibility result.

### Bot Mode and Idea Lab

Native Bot Mode supplies profile identity and discussion execution where supported. Control Room owns the
Idea Lab project/session, participant selection, round/budget limits, review and promotion. Native peer messages
are conversation transport only: no parallel global scheduler, cross-project implicit delegation or review bypass.
Initially Control Room dispatches the bounded participant turns through admitted adapters. Peer delivery is optional,
not a prerequisite or a second path for starting the same turn. No desktop window must be the always-on authority.

Project-scoped owner-visible messages and generated work are legitimate private product data. Store useful content
under explicit access/retention rules; logs and public review evidence stay sanitized. This does not authorize
wholesale collection of Hermes history, configuration, memory, credentials or unrelated profile data.

## VPS application and login

Select an explicit **Node runtime on the VPS** for the operational application. Preserve the existing Sites/Cloudflare
preview as a separate build profile; do not delete `.openai/hosting.json`, alter the lockfile, or migrate the app to D1.
Cloudflare may supply the authenticated edge/tunnel without moving transactional authority out of PostgreSQL.

B-RUNTIME must prove the installed Vinext version's Node output, startup lifecycle, static assets, routes, streaming
and shutdown. The current default `vite.config.ts` is still Worker-oriented. Upstream Node support is not proof that
our present production artifact works on the VPS. Evaluate the installed version before proposing an upgrade;
package/download changes are separately scoped. Do not switch frameworks based solely on upstream README claims.

Human login uses **Cloudflare Access with a configured identity provider**, plus application-side verification and
authorization. Do not create a custom password/TOTP vault inside Control Room. The provider must supply the owner's
password-manager-friendly password/passkey and MFA flow; selecting/configuring the actual owner account is part of
the B-AUTH setup packet, not an assumption that an account or MFA enforcement already exists.

Design policy: a seven-day maximum ordinary remembered session, capped by the verified upstream token and any
shorter owner/device policy; revocable owner membership/session state; logout; separate sessions on shared devices;
fresh step-up for credential, permission, deployment and other consequential actions. A long login is never an
owner-presence attestation or a signed effect approval. The existing 15-minute development code is not the beta login.
Cloudflare supports configurable application/policy sessions; the actual configured behavior must be tested.

One common server verifier must protect pages, APIs and event streams. Verify signature, issuer, audience and expiry
against configured trust; derive owner/tenant/project scope on the server. Never trust arbitrary client-forwarded
identity headers or treat a Sites-specific `oai-authenticated-user-id` header as VPS authentication. No live fallback
to fake identity or sample projects. Include CSRF/origin checks, safe return paths and revocation behavior in B-AUTH.
Human sessions and machine credentials are distinct; worker clients receive explicit authentication failures rather
than interactive login redirects. SSE rechecks/expiry must not leave an indefinitely authorized stream.

### Public and private addresses

Owner amendment 2026-09-07: use only the selected private hostname on the separate
existing domain, not a private subdomain of the public project domain. Cloudflare
itself is the selected login provider behind Access, with owner-specific authorization
and MFA still required. Keep exact private DNS values in protected configuration.
The formerly requested second private address is no longer a delivery requirement;
retain optional code unused and omit its configuration. This supersedes the earlier
alternate-address proposal below, not the employer-policy requirement.

- The apex `agentcontrolroom.xyz` is an independent informational/coming-soon surface, with no private-app link,
  login form, fleet details or shared application session cookie. Its public release is a separate explicit action.
- The private application uses one owner-selected subdomain. Treat its name as discoverable; authentication and
  restricted origin access protect it. No sitemap/indexing metadata should advertise private routes; robots rules
  are not a security control. Actual DNS/hostnames and credentials remain in protected deployment configuration.
- Public browser edge access, if selected, uses Access plus an origin reachable only through its configured private
  ingress. Worker and Hermes endpoints are separate private surfaces, not published by the public homepage.
- The requested alternate existing-domain address is an optional **employer-approved** access route. No automatic
  alias/proxy is built to bypass workplace filtering. If approved later, use exact origin allowlisting and independent
  host-only sessions; no cross-domain cookie sharing or blanket trust of every subdomain.
- Keep Tailscale for current reachability. Changing the VPN/control plane is not a private-beta prerequisite.

## Updates and state ownership

Browser updates and worker-runtime updates are separate. A tab reconnects to current state without restarting a job.
Drain only new admissions on the upgrading worker; let existing attempts finish within their current authority or
reconcile/cancel explicitly. Expired leases never gain a grace period just because an update is running.
Version the application/node/adapter/event contracts; accept the explicitly tested overlap during a rolling update.
Use an immutable release, one-host canary, readiness checks, compatible expand/contract database migrations, and a
rollback path whose code can read the current schema. Destructive schema rollback is not routine application rollback.

A single VPS may have a short control-plane interruption. Promise bounded reconnection/reconciliation, not literal
zero downtime. Do not lose accepted work, duplicate external effects, or mark unknown work completed. GitHub remains
bootstrap claim authority until a deliberate per-job-class cutover to PostgreSQL; Hermes's local state remains local
execution state, never a replicated replacement for the global database.

## Implementation gates and sources

CR14A changes repository planning/coordination tooling only. The next B-RUNTIME/B-AUTH/B-PROJECT-API batch may build
and deterministically test the shared foundations; it must not invoke the effects gated above. The database successor
packet separates preparation prerequisites from evidence produced by rehearsal, as specified in the completion program.
Mac owner-presence/Keychain prompts remain owner-attended. No blanket authorization substitutes for that attendance.

References checked 2026-09-04:

- [Vinext Node and deployment guidance](https://github.com/cloudflare/vinext#deployment) — latest documentation, not installed-version acceptance.
- [Cloudflare Access sessions](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/) — configuration capability, not current configuration.
- `CR14A_UPSTREAM_REUSE.md` — source-level reuse decisions, licenses and exact inspected revisions.
- `CR5C_FINAL_SECURITY_CONTRACT.md` — node authority intersection, runtime exclusions and ambiguity.
- `CONTROL_ROOM_COMPLETION_PROGRAM.md` — requirements, dependencies, owner gates and operational exits.
