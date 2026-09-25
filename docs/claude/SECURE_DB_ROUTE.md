# Secure Mac-to-VPS database route (W1)

**From:** Claude (lead). **To:** Codex. **Date:** 2026-09-25.
**Status:** revision 3.1, **owner-approved 2026-09-25**. Supersedes revisions 1
and 2 (history at the end). Revision 3.1 folds in the VPS operator's read-only
inventory (see "VPS facts").

**Progress (2026-09-25):** VPS steps 1–6 are **done and accepted**. Claude
reviewed the VPS operator's report; key outputs are quoted, sanitized, under
"VPS evidence" below. Certificate verify OK; non-SSL
connections refused; SSL connections reach SCRAM; the HTTPS route is
byte-identical; loopback-only; renewal job ran OK via the scheduler. Every
TCP `pg_hba` rule is `scram-sha-256` or `reject`. The superuser has no
password.

Accepted residual: the tagged Mac can also attempt the VPS's other
password roles over the route, and those roles don't require TLS (the
traffic is still WireGuard-encrypted). This is the same exposure those roles
already have to local VPS processes. Narrowing it later would need a
dedicated proxy. **Next:** owner steps 7–8, then Codex steps 9–10 and the
acceptance checks.

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

### VPS facts (VPS operator's read-only inventory, 2026-09-25)

- PostgreSQL 17 runs as a host process with **no systemd**: PID 1 is not an
  init system. A watchdog script under the existing Hermes cron supervises it.
  That cron is the established pattern for recurring jobs on this host.
- PostgreSQL listens on loopback only. `ssl` is already `on`, using the
  distribution's self-signed ("snakeoil") certificate.
- The existing Serve map is a single tailnet-only HTTPS route on `:443`.
- Other local consumers exist (other projects' roles and other Control Room
  roles). Their `pg_hba` rules must not change.
- `main`'s `src/web/v1/private-postgres.ts` still forces loopback and
  `ssl: false`. **The VPS must run the Mac-local integration branch**, which has
  the TLS-capable client (`private-postgres-endpoint.ts`). This is not a new
  code change.

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
3. Add **one daily renewal job to the existing Hermes cron** (there is no
   systemd on this host). It re-runs `tailscale cert`, compares the digest,
   and reloads PostgreSQL (`SELECT pg_reload_conf()` as `postgres` over the
   local socket) only if the certificate changed. It holds an exclusive
   lock (`flock -n`, so a second run exits at once), bounds each command
   with `timeout` (60 s for `tailscale cert`, 15 s for the reload), and logs
   one line on success or failure. This is the only new recurring job, and this
   owner-approved plan authorizes it.
4. Add the persistent raw TCP Serve mapping:
   `tailscale serve --bg --tcp=5432 tcp://127.0.0.1:5432`.
   **Never run `tailscale serve reset`.** Capture
   `tailscale serve status --json` before and after. The `:443` entry must be
   byte-identical afterward. If it differs at all, immediately run
   `tailscale serve --tcp=5432 off`, confirm `:443` is back, and stop.
5. `pg_hba`: Serve proxies from loopback. For exactly these four roles,
   `control_room_web`, `control_room_coordinator`, `control_room_results`
   and `control_room_queue_worker` (the `roleNames` in
   `scripts/mac-local/provision-database.mjs`), add
   `hostssl control_room <role> 127.0.0.1/32 scram-sha-256` and a following
   `host control_room <role> 127.0.0.1/32 reject`. Put both above any broader
   rule. Leave every other role's rules exactly as they are, including the
   migrator, application, scheduler and GitHub broker roles and the other
   projects' roles.
6. PostgreSQL stays bound to loopback only.

**Owner, once (see `docs/OWNER_ACTIONS.md` item 1):**

7. In the Tailscale policy file: add `tag:control-room-client` to
   `tagOwners`, and add one grant from `tag:control-room-client` to
   `tag:control-room-vps` on `tcp:5432`. Do not touch the `ssh` section.
8. Add `tag:control-room-client` to the Mac (keeping `tag:general`).

**Codex, on the Mac:**

9. **Re-point without SSH.** The existing provisioner reaches the VPS over
   `ssh`, which is the path the tagged Mac cannot use (revision 1's failure).
   Add a provisioner mode, `--repoint-only`, that makes no SSH call. It keeps
   the four role passwords already in the protected root and rewrites only
   host (the VPS Tailscale IPv4), port `5432`, and the v2 endpoint policy
   (`serverName` = the VPS MagicDNS name). Then run `pnpm mac:check-database`.
   If authentication fails because the Mac's stored passwords no longer match
   the VPS, stop and report. Do not move passwords through chat, and do not
   restore SSH as a workaround.
10. Remove any tunnel/launchd pieces that `mac:up`/`mac:down` gained for
    revisions 1–2. `mac:up` needs no network process.

## Afterward: updates, migrations, new machines

- **Upgrades/deploys:** nothing touches Tailscale, the certificate, or
  `pg_hba`.
- **Migrations:** the ledger is applied **on the VPS**, as `postgres` over
  the local socket (the provisioner's remote body today). After W1, the VPS
  operator runs that step locally on the VPS. No SSH from the Mac and no
  Tailscale change are involved. Follow-up for Codex: split that remote body
  into a VPS-local command.
- **Password rotation:** a role can change its own password over the route
  (`ALTER ROLE CURRENT_USER PASSWORD ...`, then update the protected root).
  Follow-up for Codex: no SSH is needed.
- **Certificate renewal:** automatic (step 3). No configuration change,
  because nothing is pinned.
- **New machine:** the owner adds `tag:control-room-client` to it once.
  Codex provisions its protected credentials.
- **Failure behavior:** if the route is down, database checks fail. There is
  no fallback route.

## Rollback (bounded, never touches SSH or the website)

`tailscale serve --tcp=5432 off` (that mapping only). The owner removes the
grant and the Mac's extra tag. Restore the captured `pg_hba`/`ssl` config and
reload. Remove the renewal cron job. Rotate the four Mac-local role passwords.
Verify that 5432 is unreachable from the tailnet.

## Rules

- IPs, MagicDNS names, and certificate material live only in the protected
  configuration. They never go in the repo.
- No fallback route and no plaintext retry.

## VPS evidence (2026-09-25, VPS operator's report, sanitized)

The operator's full report is held privately by the owner, because it
contains host details. These are its outputs for each check:

```
step 2  openssl s_client -starttls postgres ... -verify_hostname <name>
        subject=CN=<name>
        Verify return code: 0 (ok)            NotAfter 2026-11-21 (Let's Encrypt)
step 5a four roles: control_room_{coordinator,queue_worker,results,web}|t   (SCRAM verifiers)
step 5c sslmode=disable  -> FATAL: pg_hba.conf rejects connection ... no encryption
        verify-full      -> FATAL: password authentication failed (deliberately wrong password)
        pg_hba_file_rules errors: empty
step 3  manual run and scheduler run -> pg-cert-renew ok: unchanged   (daily 03:17 UTC)
step 4  HTTPS_ROUTE_UNCHANGED
        5432: {'TCPForward': '127.0.0.1:5432'}
        ss: LISTEN 127.0.0.1:5432, [::1]:5432 only
        website checks: identical status codes before and after
host rules (all TCP): 119 hostssl control_room <four roles> 127.0.0.1 scram-sha-256
                      120 host all <four roles> 127.0.0.1 reject
                      128/130 host all all 127.0.0.1 / ::1 scram-sha-256
                      134/135 host replication all 127.0.0.1 / ::1 scram-sha-256
login roles: the only superuser (postgres) has no password; all others are
             non-superuser with SCRAM passwords
other consumers: two other projects' databases and the watchdog OK; no
                 Control Room app server runs on the VPS
```

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
9. Renewal drill: force-run the renewal job, confirm PostgreSQL reloaded, and
   confirm `mac:check-database` still passes with no config change.
10. The existing owner SSH to the VPS and the website both pass their checks
    before and after.

W1 is done when 1–10 pass.

---

## History

- **Revision 3.1 (2026-09-25):** adds the VPS inventory. Changes: renewal runs
  on the existing Hermes cron (the host has no systemd); uses the `--tcp=5432`
  flag form with a guard on the `:443` route; names the four roles and gives
  exact `pg_hba` lines; re-points the Mac without SSH (`--repoint-only`);
  corrects the migrations note (migrations run VPS-local, not over this
  route).

- **Revision 1 (2026-09-24):** SSH tunnel over the owner's existing Tailscale
  SSH. Wrong: the tagged Mac is not covered by the `autogroup:member` /
  browser-recheck SSH rule, and a recheck can never be satisfied unattended.
- **Revision 2 (2026-09-25, same day, withdrawn):** a dedicated restricted
  OpenSSH forwarding account (`restrict,port-forwarding,permitopen`) on a
  second sshd port. It was technically sound, but it rested on a nonexistent
  owner directive. It also carried more long-term moving parts (per-machine
  keys and tunnel agents) than the owner's run-for-years goal tolerates.
