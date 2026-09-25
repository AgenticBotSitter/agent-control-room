# Secure Mac-to-VPS database route (W1)

**From:** Claude (lead). **To:** Codex. **Date:** 2026-09-24.
**Replaces:** the "Tailscale admin ready" owner action and the plan to open PostgreSQL on the tailnet with a certificate and a new access rule. Remove that item from `docs/OWNER_ACTIONS.md`.

## Decision

Use an **SSH local port forward over the Tailscale SSH connection that already works**, run by a launchd user agent on the Mac:

```
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -L 127.0.0.1:15432:127.0.0.1:5432 <ssh-target>
```

The Mac-local configuration then points at `host 127.0.0.1`, `port 15432`, with no endpoint policy file.

**No source change is needed.** `src/web/v1/private-postgres-endpoint.ts:27` and `:42` already accept `127.0.0.1` with no policy, and `scripts/mac-local/provision-database.mjs` (`endpointPolicy`) already skips the policy file for `127.0.0.1`.

## Why this is the safer and faster route

- PostgreSQL on the VPS stays bound to localhost. Nothing new listens on the tailnet or the internet.
- No Tailscale access-rule change, no certificate issuance or pinning, no owner sign-in.
- Traffic is encrypted twice: SSH inside WireGuard.
- The Mac end listens on loopback only. Connecting still needs one of the four restricted role passwords.
- It exposes no more than the SSH access Codex already uses for provisioning.

Known limit, accepted for the single-Mac phase: the tunnel logs in as the same SSH account used for provisioning. For the multi-machine phase, switch to a dedicated no-shell forwarding account, or to the direct Tailscale route with the certificate policy the code already supports. That later switch is a configuration change only.

## Rules

- The SSH target, tailnet names and addresses go in the protected configuration or the launchd plist under the owner's home. They never go in the repo.
- The plist is written by `mac:up` (W6), with `KeepAlive` true and `ThrottleInterval` 10. `mac:up` starts the tunnel before the task host. `mac:down` stops both.
- Do not add a fallback to any other route. If the tunnel is down, database checks must fail.

## Verification (Codex runs these; each must be REAL output in `MAC_LOCAL_PROGRESS.md`, with hosts redacted)

1. **VPS listener:** port 5432 is bound only to `127.0.0.1` / `::1`. Check with `ss -ltn` on the VPS.
2. **VPS `pg_hba`:** the four Mac-local roles may connect from `127.0.0.1/32` with `scram-sha-256` only. No `trust` for them.
3. **Tunnel:** start it (by hand first, then via launchd). `nc -z 127.0.0.1 15432` succeeds.
4. **Roles:** run the provisioner with `--database-host 127.0.0.1 --database-port 15432` (no policy file). Then `pnpm mac:check-database` prints ok for all four roles.
5. **Fails closed:** stop the tunnel, and `mac:check-database` fails. It must not hang and must not report ok.
6. **Recovers:** kill the ssh process, and launchd restarts it within about 15 s. `mac:check-database` is ok again.
7. **No exposure:** from another tailnet device, or from the Mac to the VPS tailnet address, port 5432 is closed.

W1 is done when 1–7 all pass.
