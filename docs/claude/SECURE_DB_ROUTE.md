# Secure Mac-to-VPS database route (W1)

**From:** Claude (lead). **To:** Codex. **Date:** 2026-09-24, revised 2026-09-25.
**Status:** revision 2. Revision 1 (below, kept for the record) is wrong — its
central assumption did not hold under live testing. This is the resolved
design. Nothing in this file has been applied yet: no Tailscale policy,
PostgreSQL, or service change exists on any host.

## What live testing found (2026-09-25)

Revision 1 assumed the Mac could already SSH to the VPS over Tailscale, and
proposed reusing that connection. Live testing disproved it: the Mac carries
`tag:general`, the VPS carries `tag:control-room-vps`, and the existing
Tailscale SSH ACL rule is scoped to `autogroup:member` with a browser
recheck. A tagged device is never covered by that rule — signing out and back
in on the Mac does not remove the tag and would not have helped. The working
SSH access Codex used for provisioning was the owner's own attended session,
not something the Mac itself can reach unattended. Separately, a `check`-mode
Tailscale SSH rule requires periodic interactive reauthentication in a
browser, which a launchd background service can never satisfy — so even if
the ACL had covered the tag, revision 1's "run it as a launchd agent" plan
would still have stalled the first time the recheck window lapsed.

Two proposals followed. Codex proposed a one-time dedicated Mac identity and
a private, restricted SSH endpoint limited to forwarding into PostgreSQL. The
review response (Opus) correctly flagged that "no shell" is not the same as
"can only reach PostgreSQL" — an OpenSSH account with forwarding enabled and
no server-side destination restriction can forward to anything the VPS can
reach, not just `127.0.0.1:5432` — and proposed opening PostgreSQL directly
to a dedicated tag instead.

The direct-tailnet-PostgreSQL option is not a technical tradeoff to
re-litigate here: the owner has already directed that PostgreSQL stay
unreachable directly over the tailnet, and that directive is not this
document's to override. So the shape has to be Codex's: SSH-mediated, not a
raw database listener. Opus's finding about "no shell" being insufficient is
correct and real, and revision 1 didn't address it either (it reused a
general-purpose provisioning account with no destination restriction at
all). This revision keeps Codex's SSH-endpoint shape and closes the gap Opus
found with the standard OpenSSH mechanism built for exactly this: a
restricted `authorized_keys` entry.

## Decision

A dedicated, restricted-purpose OpenSSH listener on the VPS, reached over a
**second, narrow Tailscale network ACL grant that is not the `ssh` policy
stanza at all** — so the existing `autogroup:member`/recheck rule, the
existing provisioning SSH access, and the website's Serve route are all
completely untouched. This is deliberately not Tailscale SSH: Tailscale SSH's
identity/recheck layer is what blocked revision 1 and is structurally
unsuited to an unattended agent regardless of ACL scope. The new path
authenticates the ordinary way — an ed25519 keypair OpenSSH already knows how
to restrict — and Tailscale's job here is purely the encrypted network path,
the same job it already does for the working SSH and HTTPS routes.

### One-time setup

1. **VPS: dedicated system account.** Create a service account with no login
   shell (e.g. `nologin`), e.g. `crtunnel` — no interactive password, no
   sudo, no group membership beyond its own. Codex picks the exact name per
   VPS convention.
2. **Mac: dedicated keypair.** Generate a fresh ed25519 keypair for this
   account only. The private key lives unencrypted under the Mac's existing
   owner-only protected root (`0600`, same directory class as the four
   Postgres role password files `provision-database.mjs` already writes) —
   it has to be unencrypted because nothing is present to type a passphrase
   when launchd restarts the tunnel. Filesystem permissions plus the Mac's
   disk encryption are the protection, exactly as they already are for the
   role passwords.
3. **VPS: restricted `authorized_keys` entry.** Install the public key for
   `crtunnel` with:
   ```
   restrict,port-forwarding,permitopen="127.0.0.1:5432" ssh-ed25519 AAAA... crtunnel@mac-local
   ```
   `restrict` (OpenSSH ≥7.2) disables PTY, X11 forwarding, agent forwarding,
   and remote/dynamic port forwarding in one flag. `port-forwarding`
   re-enables *local* forwarding only. `permitopen` is the fix for the gap
   Opus flagged: the server refuses to open any destination through this key
   except exactly `127.0.0.1:5432`, no matter what the client asks for.
4. **VPS: a second sshd listener, not a change to the existing one.** Bind a
   second sshd instance to a distinct, non-22 port with its own minimal
   config (`Include` drop-in), scoped to the `crtunnel` account only,
   `PasswordAuthentication no`. Using a separate listener — not a `Match
   User` block bolted onto the existing sshd on port 22 — keeps this
   entirely additive: the existing sshd config, the existing SSH access, and
   the existing "ssh" ACL stanza never get touched or diffed.
5. **Tailscale: one added network ACL line, not a change to the `ssh`
   stanza.** Grant `tag:general` → `tag:control-room-vps:<the new port>`,
   TCP only, and nothing else. This is a plain `acls` grant, not the `ssh`
   policy block revision 1 depended on — it carries no `autogroup:member`
   requirement and no recheck. One line, one diff, reviewable on its own.
6. **Mac: launchd user agent.** Same shape as revision 1 already specified:
   ```
   ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes \
       -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
       -i <protected-key-path> -p <new-port> \
       -L 127.0.0.1:15432:127.0.0.1:5432 crtunnel@<vps-tailnet-name>
   ```
   `KeepAlive` true, `ThrottleInterval` 10, started by `mac:up` before the
   task host, stopped by `mac:down`.
7. **Mac-local configuration is unchanged from revision 1:** `host
   127.0.0.1`, `port 15432`, no endpoint policy file. **No source change is
   needed** — `src/web/v1/private-postgres-endpoint.ts:27` and `:42` already
   accept `127.0.0.1` with no policy, and `provision-database.mjs`
   (`endpointPolicy`) already skips the policy file for `127.0.0.1`.

### Why this meets every constraint the owner gave

- **PostgreSQL stays unreachable directly over the tailnet** — the ACL grant
  targets the new SSH port only, never 5432, and `permitopen` re-confirms it
  server-side even if the client tried.
- **No automatic root access** — `crtunnel` is a fresh, unprivileged, no-shell
  account touching nothing but its own forwarded socket.
- **Set up once, reconnects automatically** — key-based auth, no browser
  recheck, no human in the loop after step 1–6; launchd handles sleep/restart
  recovery the same way revision 1 already planned.
- **No tag changes, no owner clicks for routine work** — the Mac keeps
  `tag:general` permanently; the one ACL edit is a one-time setup step, not a
  per-session action.
- **Existing SSH and the website are preserved** — nothing in steps 1–5
  touches the existing sshd config, the existing `ssh` ACL stanza, the
  existing provisioning account, or the HTTPS Serve route.

### Updates and migrations afterward

Nothing new. The tunnel is already up (via `mac:up`) before any deploy or
migration runs. Migrations use the existing migrator role over the same
`127.0.0.1:15432` path — `permitopen` only ever reaches the one socket
PostgreSQL already listens on, so role separation (migrator vs. app vs.
results vs. queue worker) is enforced by PostgreSQL itself, exactly as today,
not by the tunnel.

### Restart and credential-expiry handling

launchd's `KeepAlive`/`ThrottleInterval` restarts the tunnel after sleep,
network loss, or process death — unchanged from revision 1. The key does not
expire on a schedule; rotate it deliberately: generate a new keypair, add the
new public key as a second `authorized_keys` line alongside the old one,
swap the protected private-key file on the Mac, restart the LaunchAgent,
confirm the tunnel reconnects, then delete the old `authorized_keys` line.
Zero downtime, no owner action required mid-rotation.

### Rollback

Unload and remove the LaunchAgent; delete the `crtunnel` `authorized_keys`
entry (or the account); remove the one added Tailscale ACL line; stop the
second sshd listener. None of that touches the existing SSH account, the
existing `ssh` ACL stanza, or the website's Serve route — rollback here
cannot regress either of the two things the owner said must keep working.

## Rules

- The SSH target, tailnet names, ports, and addresses go in the protected
  configuration or the launchd plist under the owner's home. They never go in
  the repo.
- Do not add a fallback to any other route. If the tunnel is down, database
  checks must fail.

## Verification (Codex runs these; each must be REAL output in `MAC_LOCAL_PROGRESS.md`, with hosts and ports redacted)

1. **VPS listener:** the new sshd port is bound only where the tailnet
   interface reaches it, not the public internet. Check with `ss -ltn`.
2. **`authorized_keys` restriction:** the `crtunnel` line reads exactly
   `restrict,port-forwarding,permitopen="127.0.0.1:5432"` — no PTY, no
   agent/X11 forwarding, no remote/dynamic forwarding, no other destination.
3. **ACL diff:** the Tailscale policy change is exactly one added `acls`
   line; the existing `ssh` stanza and the website's rules are byte-for-byte
   unchanged. Diff the policy JSON before/after.
4. **Non-interactive auth:** from the Mac, `ssh -o BatchMode=yes ... -p
   <new-port> crtunnel@<vps>` succeeds with zero prompts.
5. **Tunnel:** start it (by hand first, then via launchd). `nc -z 127.0.0.1
   15432` succeeds.
6. **`permitopen` actually holds:** attempt a *different* forwarded
   destination through the same key (e.g. `-L 127.0.0.1:19999:127.0.0.1:22`)
   and confirm the server refuses it. This is the live proof that the gap
   Opus flagged is closed, not just documented.
7. **VPS `pg_hba`:** the four Mac-local roles may connect from `127.0.0.1/32`
   with `scram-sha-256` only. No `trust` for them.
8. **Roles:** run the provisioner with `--database-host 127.0.0.1
   --database-port 15432` (no policy file). Then `pnpm mac:check-database`
   prints ok for all four roles.
9. **Fails closed:** stop the tunnel, and `mac:check-database` fails. It must
   not hang and must not report ok.
10. **Recovers:** kill the ssh process, and launchd restarts it within about
    15 s. `mac:check-database` is ok again.
11. **No exposure:** from another tailnet device, or from the Mac to the VPS
    tailnet address directly, port 5432 is closed, and the new SSH port is
    closed to any tag other than `tag:general`.
12. **Nothing else regressed:** the existing owner/provisioning SSH access
    and the existing website route both still pass their own health checks,
    unchanged, before and after.

W1 is done when 1–12 all pass.

---

## Revision 1 (2026-09-24) — superseded, kept for the record

Use an **SSH local port forward over the Tailscale SSH connection that already works**, run by a launchd user agent on the Mac:

```
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -L 127.0.0.1:15432:127.0.0.1:5432 <ssh-target>
```

**Why this was wrong:** it assumed the Mac's own Tailscale SSH access already
worked unattended. It didn't — see "What live testing found" above. The
"known limit, accepted for the single-Mac phase" note below correctly
anticipated needing a dedicated no-shell forwarding account eventually; that
need turned out to be immediate, not deferred, and revision 2 is that
account, built with the destination restriction (`permitopen`) revision 1
never specified.

Known limit, accepted for the single-Mac phase: the tunnel logs in as the same SSH account used for provisioning. For the multi-machine phase, switch to a dedicated no-shell forwarding account, or to the direct Tailscale route with the certificate policy the code already supports. That later switch is a configuration change only.
