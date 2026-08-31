# Security, redaction, and authority invariants

- Control Room is private and protected by Cloudflare Access in deployment.
- Workers and adapters use outbound HTTPS and individual revocable credentials.
- Network location, Proton VPN, LAN, or Tailscale membership never grants authority.
- Control Room owns its global registry, projections, allocation policies, recommendations, and audit.
- One private PostgreSQL primary on the Hostinger KVM2 VPS is Control Room's sole global write authority.
- PostgreSQL accepts only host-local socket/loopback/private-network access; no public inbound database endpoint is permitted.
- AWS RDS is not the initial production target. PGlite is local-development/test-only. R2 is artifacts/backups, never transactional or coordination state.
- A source-scheduled project owns job eligibility, leases, and domain transitions.
- A native project pack may delegate scheduling to Control Room explicitly.
- Raw media and large artifacts remain in approved local/R2 storage.
- Control Room does not become a universal secret vault.
- Logs, fixtures, tests, and database projections use privacy-safe labels only.
- Audit rows are append-only; projections are replaceable caches tied to source versions.
- No live command, credential, render, transcript, or project mutation is authorized in CR-0 through CR-2.
