> **Restore note:** Restored from history on 2026-09-27; historical architecture record; newer decisions in `docs/LOCAL_TO_MULTI_SYSTEM_EXECUTION_PLAN.md` take precedence where they conflict.

# Security, redaction, and authority invariants

Current delivery direction: ADR-253 / `docs/UNIFIED_TOPOLOGY_BUILD_PLAN.md`, then
`CR14A_INTEGRATION_DIRECTION.md` for the private-server profile. The statements below describe
required production invariants, not evidence that production has been configured. These decisions do not
enable an old disabled runtime or waive a native, credential, database or deployment gate.

- The private-server profile uses Cloudflare Access. The single-computer profile requires its own
  separately accepted local owner-authentication and recovery contract; it has no automatic login fallback.
- Workers and adapters use outbound HTTPS and individual revocable credentials.
- Network location, Proton VPN, LAN, or Tailscale membership never grants authority.
- Control Room owns its global registry, projections, allocation policies, recommendations, and audit.
- Each installation has exactly one private PostgreSQL primary as Control Room's sole write authority.
  The selected VPS provider is the chosen private-server deployment profile, not a required placement for every installation.
- PostgreSQL accepts only host-local socket/loopback/private-network access; no public inbound database endpoint is permitted.
- AWS RDS is not the initial production target. PGlite is local-development/test-only. R2 is artifacts/backups, never transactional or coordination state.
- A source-scheduled project owns job eligibility, leases, and domain transitions.
- A native project pack may delegate scheduling to Control Room explicitly.
- Raw media and large artifacts remain in approved local/R2 storage.
- Control Room does not become a universal secret vault.
- Logs, fixtures, tests, and database projections use privacy-safe labels only.
- Audit rows are append-only; projections are replaceable caches tied to source versions.
- No live command, credential, render, transcript, or project mutation is authorized in CR-0 through CR-2.
