# Control Room — Connectivity, VPN, and Offline-Resilience Plan

**Decision:** Control Room does not require a custom VPN and does not depend on Tailscale, Proton VPN, or any single network path. Security is enforced at the application layer. Tailscale is an optional private/admin and transfer path.

## 1. Required versus optional connectivity

### Required control path

Every worker, agent integration, and browser can reach the Control Room API using ordinary outbound HTTPS on TCP 443:

```text
Worker/Agent -> HTTPS -> Cloudflare -> Cloudflare Tunnel -> Control Room VPS
```

- No home router port forwarding.
- No inbound connection to a worker.
- No fixed home IP requirement.
- No reliance on Proton or Tailscale IP addresses.
- A scoped, revocable application identity authenticates every worker and agent.
- Cloudflare Access protects the human web interface.

Proton VPN may carry this HTTPS traffic when enabled, but Control Room does not need to know or trust the Proton exit IP.

### Optional private paths

Tailscale or the home LAN may be used for:

- SSH/RDP/remote administration;
- authenticated SMB transfer between the Mac and Windows archive;
- direct large-artifact transfer when faster than R2;
- an optional secondary Control Room endpoint;
- emergency diagnostics when the public path is unavailable but the tailnet works.

These paths improve convenience or speed but are not prerequisites for scheduling, status, approvals, or future workers.

### Universal transfer fallback

R2 over HTTPS is the transfer fallback for workers that are not on the home LAN or tailnet. Full-resolution media should prefer LAN/approved direct transfer when available; review proxies and manifests can use R2 routinely.

## 2. Network-path selection

Workers maintain a path table rather than assuming one route:

| Purpose | Preferred | Secondary | Fallback |
|---|---|---|---|
| API/heartbeats | Public Control Room HTTPS | Tailscale HTTPS endpoint if configured | Durable offline spool |
| Small artifacts/proxies | R2 HTTPS | Public API upload if supported | Local spool |
| Large Mac/PC media | Authenticated home LAN | Tailscale direct path | R2 multipart upload |
| VPS administration | Tailscale SSH | Provider console/approved public SSH policy | Host recovery process |

The worker measures reachability, latency, and throughput and selects only configured, authorized paths. It never exposes SMB, Unreal, FFmpeg, or its local spool to the public internet.

## 3. Proton VPN coexistence

Proton VPN can affect Control Room in three ways:

1. **Kill switch:** When Proton disconnects, a kill switch can intentionally block all network traffic.
2. **LAN filtering:** Proton may block local Mac-to-PC traffic unless LAN connections are allowed.
3. **VPN-route conflict:** Proton and Tailscale can compete for routes, DNS, or operating-system VPN facilities.

Recommended configuration:

- Keep the Control Room public HTTPS endpoint accessible through Proton normally.
- Enable Proton's **Allow LAN connections** setting on the Mac and Windows PC when direct local transfer is desired.
- Do not make Control Room dependent on simultaneous Proton and Tailscale operation.
- If both must operate on Windows and testing shows a conflict, use Proton split tunneling for the Tailscale address ranges and any configured tailnet subnet routes.
- Treat Proton Advanced Kill Switch as authoritative: when it blocks connectivity, the worker becomes temporarily disconnected and relies on its local spool.
- Do not use a Tailscale exit node simultaneously with Proton for Control Room workers.
- Test macOS separately; do not assume the Windows split-tunnel configuration behaves identically.

Tailscale uses `100.64.0.0/10` for IPv4 and `fd7a:115c:a1e0::/48` for IPv6. These ranges and any advertised subnet routes are the relevant exclusions when supported. Configuration should be documented per machine after an actual coexistence test rather than applied blindly.

On iOS and Android, only one VPN can generally be active at a time. The mobile Control Room therefore uses its Cloudflare-protected public HTTPS hostname and does not require Tailscale.

## 4. Worker behavior during connectivity loss

Every worker has a durable local spool containing:

- its current signed job lease and immutable job specification;
- checkpoints and progress;
- logs and telemetry waiting to send;
- artifact manifests and checksums;
- completed outputs waiting for transfer;
- idempotency keys for acknowledgments and commands.

### State model

```text
Online -> Degraded Path -> Disconnected, Work Continuing
       -> Disconnected, Paused Safely
       -> Reconnected, Reconciling -> Online
```

Whether a job continues offline is adapter- and policy-specific:

- Deterministic frame-range render with all inputs local: continue.
- FFmpeg encode with local inputs/output: continue.
- R2 transfer: pause and resume.
- Job requiring a new approval, credential, or remote input: pause.
- Destructive or externally consequential operation: never continue without fresh authority.

The scheduler uses a disconnect grace period and does not immediately duplicate long-running work merely because one heartbeat is missed. On reconnection, the worker reconciles its signed lease, progress, outputs, and checksums before new work is assigned.

## 5. Dashboard visibility

The worker page distinguishes machine health from network-path health:

```text
M4 Wayfarer
Machine: Healthy
Current render: Continuing locally
Control connection: Disconnected for 4m 12s
Last path: Proton VPN / public HTTPS
Tailscale path: Unavailable
LAN archive path: Reachable
Telemetry and logs queued locally: 3.8 MB
```

The global Network view shows:

- current path for each worker;
- public HTTPS, Tailscale, LAN, and R2 reachability;
- round-trip latency and recent throughput;
- connection-loss history;
- queued offline events and artifacts;
- workers repeatedly affected by one VPN or route;
- whether production is delayed or merely temporarily unobservable.

Alerts should differentiate:

- worker process stopped;
- entire machine offline;
- Control Room path blocked;
- Tailscale unavailable but public HTTPS healthy;
- LAN transfer unavailable but R2 fallback healthy;
- all paths unavailable;
- Proton/route conflict suspected from repeated pattern.

## 6. Security model without VPN dependence

- TLS for all API and R2 traffic.
- Unique worker, agent, and user identities.
- Scoped, revocable credentials; no shared master token.
- Short-lived access tokens with controlled rotation where practical.
- Permission and project-scope checks on every command.
- Signed job specifications and artifact manifests.
- Replay/idempotency protection.
- No trust based only on source IP, LAN membership, or tailnet membership.
- No worker listening on a public port.
- Tailscale ACLs/grants still restrict optional private access.
- Credentials remain outside Git, Telegram messages, job text, and logs.

This allows a future worker that cannot or should not join the tailnet to participate safely through the standard HTTPS enrollment flow.

## 7. Do we need our own VPN?

No. Operating a new VPN would create another routing layer, client, credential system, firewall interaction, and failure mode without improving the core application model.

A custom site-to-site tunnel should be considered only if a future requirement needs continuous private non-HTTP networking between locations, a cloud render vendor mandates it, or measured transfer volume makes a dedicated link worthwhile. It is not required for the Control Room MVP or the home Mac/PC/VPS topology.

## 8. Initial rollout tests

Connectivity acceptance tests should cover:

1. Proton off, Tailscale on.
2. Proton on, Tailscale off.
3. Proton and Tailscale on together where supported.
4. Proton reconnect and standard kill-switch event.
5. Advanced kill-switch event if the user keeps it enabled.
6. LAN transfer with Proton Allow LAN enabled.
7. Tailscale path failure with public HTTPS still working.
8. Public API failure with a configured Tailscale secondary path.
9. Total network loss during an Unreal frame-range render.
10. Total network loss during R2 multipart transfer.
11. Reconnection and state reconciliation without duplicate execution.
12. Future worker enrollment with no Tailscale installed.

The result is recorded per worker because Windows, macOS, Linux, VPN version, firewall, and route configuration can behave differently.

## 9. Recommended initial topology

```text
Human web/phone
  -> Cloudflare Access + public HTTPS

All workers
  -> public HTTPS Control Room API (required primary control path)

VPS administration
  -> Tailscale (preferred administrative path)

Mac <-> Windows PC masters
  -> authenticated Ethernet/LAN transfer with Proton LAN allowed
  -> Tailscale optional, not required
  -> R2 fallback

Future workers
  -> public HTTPS enrollment and control
  -> Tailscale optional if the owner chooses to add them
```

This topology retains the security and convenience of the existing tailnet while preventing Proton/Tailscale coexistence from becoming a production dependency.
