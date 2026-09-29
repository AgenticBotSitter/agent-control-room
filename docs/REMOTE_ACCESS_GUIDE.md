# Open Control Room from your phone and your other computers

Control Room runs on your Mac and only ever listens on `127.0.0.1` (the Mac itself).
Two optional doors lead to it. Each one is off until you turn it on.

| Door | For | Who can reach it | Sign-in |
| --- | --- | --- | --- |
| **Tailscale Serve** | your phone | only devices on your tailnet | your owner code |
| **Cloudflare Tunnel + Access** | your other computers (no Tailscale) | only your exact email, after Cloudflare login and authenticator-app MFA | Cloudflare, then your owner code |

The real addresses are private. They go only in your protected file
`<protected-root>/config/mac-local.json`, never in this repository, and the public site
`agentcontrolroom.xyz` never links to them. The addresses below are examples.

Nothing here installs software or opens a port on your router. `pnpm mac:remote-access`
only prints steps, writes one file into your protected folder, and checks your setup.

## Before you start (once)

- Tailscale is installed on the Mac and the phone, both signed in to the same tailnet.
  In the Tailscale admin console, **DNS**: MagicDNS on, HTTPS certificates on.
- For the Cloudflare door: a domain you already own is on Cloudflare, you have a
  Cloudflare Zero Trust team (the free plan is enough), and `cloudflared` is installed.

## 1. Tell Control Room about the doors

Stop Control Room (`pnpm mac:down -- --protected-root <protected-root>`), then add this
block at the top level of `mac-local.json`. Keep only the doors you want.

```json
"remoteAccess": {
  "schema": "control-room.mac-local-remote-access/v1",
  "tailscale": { "origin": "https://your-mac.your-tailnet.ts.net", "ownerLogin": "you@example.com" },
  "cloudflare": {
    "origin": "https://your-private-name.your-domain.example",
    "teamDomain": "https://your-team.cloudflareaccess.com",
    "audience": "<Application Audience (AUD) tag, 64 characters>",
    "ownerEmail": "you@example.com"
  }
}
```

- `origin` is the exact HTTPS address: no path, port, slash or wildcard.
- `ownerLogin` (optional) must be your Tailscale login in lower case, as the Tailscale admin
  console shows it (for example `you@example.com`, or `you@github` / `you@passkey`). With it,
  only your own tailnet account gets in, not other people or tagged devices on the tailnet.
- `ownerEmail` must be the exact email Cloudflare signs in, in lower case.
- If an older `trustedOrigin` line is in `localOwnerSession`, remove it and use
  `remoteAccess.tailscale` instead (both together are refused). Until you do, the old line
  works only if it is your Tailscale `ts.net` address; any other address stops Control Room
  from starting.

Run `pnpm mac:remote-access plan --protected-root <protected-root>` to see your exact commands.

## 2. Phone: Tailscale Serve

1. `tailscale serve --bg --https=443 http://127.0.0.1:3210`
2. `tailscale serve status` must show your `ts.net` address pointing at `http://127.0.0.1:3210`.
3. Start Control Room (`pnpm mac:up -- --protected-root <protected-root>`), open the `ts.net`
   address on the phone and sign in with your owner code.

Never use `tailscale funnel`. It would publish the address to the whole internet. Control Room
refuses every request Tailscale marks as coming through Funnel, but do not rely on that.
To turn it off: `tailscale serve --https=443 off`.

## 3. Other computers: Cloudflare Access, then the tunnel

**In the Cloudflare Zero Trust dashboard (about 20 minutes):**

1. **Settings → Authentication → Login methods:** add a login whose account uses an
   authenticator app for two-step sign-in (for example GitHub or Google with an
   authenticator app turned on). Do not rely on the emailed one-time PIN; it is not an
   authenticator app. If your dashboard offers Access's own multi-factor setting, turn it on
   with **Authenticator application**.
2. **Settings → Authentication → Global session timeout:** a long value such as 1 month.
   This is the "remember this device" part: you sign in with MFA about once a month per device.
3. **Access → Applications → Add an application → Self-hosted.**
   - Domain: your private name, for example `your-private-name.your-domain.example`.
   - Session duration: 24 hours.
   - Policy: **Allow**, Include **Emails** = your email. Add no other rule or group.
   - Login method: only the one from step 1.
4. Open the application and copy its **Application Audience (AUD) Tag** into
   `remoteAccess.cloudflare.audience`. Your team domain is shown under **Settings → Custom
   pages** (`<team>.cloudflareaccess.com`).

**On the Mac:**

1. `cloudflared tunnel login`
2. `cloudflared tunnel create control-room` (note the tunnel ID and the `.json` file it names)
3. Move that `.json` file into `<protected-root>/config/` and `chmod 600` it.
4. `pnpm mac:remote-access write-cloudflared --protected-root <protected-root> --tunnel-id <TUNNEL-ID> --credentials-file <protected-root>/config/<TUNNEL-ID>.json`
5. `cloudflared tunnel route dns control-room your-private-name.your-domain.example`
6. `pnpm mac:remote-access check --protected-root <protected-root>` must show only PASS lines.
7. Start Control Room, then `cloudflared tunnel --config <protected-root>/config/cloudflared.yml run control-room`.

The tunnel only dials out to Cloudflare, so nothing on the Mac is reachable from the
internet. On another computer, open your private address: Cloudflare login + MFA, then your
owner code. Straight after the Cloudflare login you may see a short "Continue to Control Room"
page for a moment; it moves on by itself (or click the link).

## Signing out, expiry and revoking

- **Sign out** (in the Control Room menu) ends the Control Room session on that device. On the
  Cloudflare address it also ends this site's Cloudflare sign-in in that browser. It does not
  sign you out of Cloudflare everywhere: while your wider Cloudflare login lasts, the next visit
  may let you straight back to the owner-code page without MFA. Use **Revoke session** (below)
  when that matters.
- Control Room sessions end on their own after the configured time (at most 24 hours). An
  expired Cloudflare token is refused even if the Control Room session is still valid.
- **Lost device:** Zero Trust → **My Team → Users** → you → **Revoke session**, and on
  Tailscale remove the device from the admin console. If the owner code may have been seen,
  change it in `mac-local.json` and restart Control Room: that ends every Control Room session.

## What protects you

- The Mac listens only on `127.0.0.1`. There is no router port to open.
- On the Cloudflare address every request, including images and scripts, must carry a
  Cloudflare Access token that Control Room itself checks: Cloudflare's signature (keys
  refreshed automatically when Cloudflare rotates them), your application's AUD tag, your
  team, the time window and your exact email. `cloudflared` checks the token too. A request
  without a valid token is refused, even from the Mac itself.
- Every write still needs the exact page address (no cross-site forms) and your owner session.
- Bots and worker machines never use your browser sign-in; they have their own credentials.
- The hard-to-guess address is extra privacy, not the lock.
