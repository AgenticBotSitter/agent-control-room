# Secure Mac-to-VPS database route (W1)

**From:** Claude (lead). **To:** Codex. **Date:** 2026-09-25.
**Status:** revision 3, **owner-approved 2026-09-25**. Supersedes revisions 1
and 2 (history at the end). Nothing here has been applied yet.

## Decision

The Mac reaches the VPS's PostgreSQL **directly over Tailscale**, restricted
to one dedicated tag, with PostgreSQL's own TLS and SCRAM passwords. There is
no SSH tunnel and no Mac background service. This is the route
`docs/PRIVATE_POSTGRES_TAILSCALE_SERVE_ACTIVATION.md` already designed and
`src/web/v1/private-postgres-endpoint.ts` already supports, with one code
change (below) so that it survives certificate renewal.

### Why (the owner's requirement governs this choice)

The owner wants a system that runs for years, through upgrades and new
machines, with no owner action after a single one-time setup. Measured
against that goal:

- **Fewest moving parts.** No tunnel process to die on sleep, no SSH keys to
  rotate, no per-machine launchd agent. The application's normal database
  pool handles reconnection.
- **Adding a machine** needs only the tag plus its protected role
  credentials, and no VPS change.
- **Tagged devices have no Tailscale key expiry**, so there is no periodic
  re-login. The browser recheck stays on the owner's own SSH access only.
- **Protection:** only devices carrying the new tag can reach the port, and
  the connection is WireGuard, plus PostgreSQL TLS, plus a per-role SCRAM
  password.

Revision 2 claimed an owner directive against this route. **No such
directive exists.** The owner did not make it. That sentence was repeated
from a relayed message without checking, and is withdrawn.

### Current tailnet facts (owner-supplied, 2026-09-25)

- Mac: `tag:general`. VPS: `tag:control-room-vps`, with Tailscale SSH
  enabled. The owner's phone and PC also carry `tag:general`.
- Because `tag:general` is shared with the phone and PC, the database grant
  must use a **new dedicated tag**, `tag:control-room-client`.
- The Mac **keeps `tag:general` and gains `tag:control-room-client`**. A
  device may hold several tags. Removing `tag:general` could silently cut
  whatever that tag already grants the Mac, such as website access.
- Tailscale client versions are all ≥ 1.102, which supports persistent TCP
  Serve.

## Required code change (Codex, before any live step)

`privatePostgresTlsOptionsV1` currently requires a publicly trusted chain
**and** pins the exact leaf certificate (`certificateSha256`). The
certificates Tailscale issues (`tailscale cert`, Let's Encrypt) renew about
every 60–90 days. Each renewal would change the leaf, break every connection,
and require a protected-configuration edit. That is exactly the recurring
intervention the owner ruled out.

Change it to **standard verification**: keep `rejectUnauthorized: true`,
`minVersion: TLSv1.2`, the separate `servername` (the VPS's MagicDNS name),
and `checkServerIdentity` against that name. Keep the numeric-IP routing
rule and no custom trust root. **Remove the exact-leaf pin.** Version the
policy (`private-postgres-endpoint/v2`, without `certificateSha256`) and
refuse v1 policies so that no stale pin lingers. Update the endpoint tests.
Justification: device admission is already authenticated by WireGuard and
the ACL. TLS with standard chain and name validation remains the
defense-in-depth layer. The pin added breakage and no protection this
threat model needs.

## One-time setup

**Codex, on the VPS (harmless before the ACL exists, because nothing can reach it yet):**

1. Inspect how PostgreSQL runs (host service or container), its config
   paths, and every current local consumer and role that uses it. Record the
   inventory, sanitized.
2. Issue the machine certificate with `tailscale cert` for the VPS's MagicDNS
   name. Install the cert and key where PostgreSQL reads them, with the key
   `0600` and owned by the PostgreSQL user. Set `ssl = on`.
3. Install a **systemd timer** (daily) that re-runs `tailscale cert`. It
   reloads PostgreSQL only if the file changed; PostgreSQL re-reads SSL
   files on reload. It logs one line on success or failure. This is the
   only new persistent unit, and it is authorized by this owner-approved
   plan.
4. Add the persistent raw TCP Serve mapping:
   `tailscale serve --bg --tcp 5432 tcp://127.0.0.1:5432`.
   **Never run `tailscale serve reset`**, and do not change the existing
   HTTPS Serve route. Capture `tailscale serve status` before and after.
5. `pg_hba`: Serve proxies from loopback, so for the four Mac-local roles
   require `hostssl ... 127.0.0.1/32 scram-sha-256`, and reject non-SSL
   `host` for those roles. Leave the other consumers' rules as they are,
   per the step-1 inventory.
6. PostgreSQL stays bound to loopback only.

**Owner, once (see `docs/OWNER_ACTIONS.md` item 1):**

7. In the Tailscale policy file: add `tag:control-room-client` to
   `tagOwners`, and add one grant from `tag:control-room-client` to
   `tag:control-room-vps` on `tcp:5432`. Do not touch the `ssh` section.
8. Add `tag:control-room-client` to the Mac (keeping `tag:general`).

**Codex, on the Mac:**

9. Re-run the provisioner with `--database-host <VPS Tailscale IPv4>
   --database-port 5432 --endpoint-policy-file <protected v2 policy>`. The
   policy's `serverName` is the VPS MagicDNS name. Then run
   `pnpm mac:check-database`.
10. Remove any tunnel/launchd pieces that `mac:up`/`mac:down` gained for
    revisions 1–2. `mac:up` needs no network process.

## Afterward: updates, migrations, new machines

- **Upgrades/deploys:** nothing touches Tailscale, the certificate, or
  `pg_hba`.
- **Migrations:** they run as today, as the migrator role over the same
  route. Role separation is enforced by PostgreSQL.
- **Certificate renewal:** automatic (step 3). No configuration change,
  because nothing is pinned.
- **New machine:** the owner adds `tag:control-room-client` to it once.
  Codex provisions its protected credentials.
- **Failure behavior:** if the route is down, database checks fail. There is
  no fallback route.

## Rollback (bounded, never touches SSH or the website)

`tailscale serve --tcp 5432 off` (that mapping only). The owner removes the
grant and the Mac's extra tag. Restore the captured `pg_hba`/`ssl` config and
reload. Disable the renewal timer. Rotate the four Mac-local role passwords.
Verify that 5432 is unreachable from the tailnet.

## Rules

- IPs, MagicDNS names, and certificate material live only in the protected
  configuration. They never go in the repo.
- No fallback route and no plaintext retry.

## Live acceptance (REAL output in `MAC_LOCAL_PROGRESS.md`, hosts redacted)

1. VPS: PostgreSQL is listening on loopback only (`ss -ltn`).
2. `tailscale serve status`: the new TCP 5432 mapping is present, and the
   HTTPS route is byte-identical to before.
3. Policy diff: only the new tag owner and the one grant were added. The
   `ssh` section is unchanged.
4. Mac: `pnpm mac:check-database` passes for all four roles over the
   direct route.
5. Wrong-name or untrusted certificate: the connection refuses, with no
   plaintext retry (a focused test plus one live wrong-`serverName` attempt).
6. A non-SSL connection attempt by a Mac-local role is refused by `pg_hba`.
7. The phone or PC (`tag:general` only) cannot connect to VPS:5432.
8. Mac sleep/wake, a VPS PostgreSQL restart, and a VPS Tailscale restart all
   recover without intervention. `mac:check-database` passes after each.
9. Renewal drill: force-run the timer, confirm PostgreSQL reloaded, and
   confirm `mac:check-database` still passes with no config change.
10. The existing owner SSH to the VPS and the website both pass their checks
    before and after.

W1 is done when 1–10 pass.

---

## History

- **Revision 1 (2026-09-24):** SSH tunnel over the owner's existing Tailscale
  SSH. Wrong: the tagged Mac is not covered by the `autogroup:member` /
  browser-recheck SSH rule, and a recheck can never be satisfied unattended.
- **Revision 2 (2026-09-25, same day, withdrawn):** a dedicated restricted
  OpenSSH forwarding account (`restrict,port-forwarding,permitopen`) on a
  second sshd port. It was technically sound, but it rested on a nonexistent
  owner directive. It also carried more long-term moving parts (per-machine
  keys and tunnel agents) than the owner's run-for-years goal tolerates.
