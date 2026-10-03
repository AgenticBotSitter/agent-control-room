# Open Control Room from another computer

**Legacy checkout route only.** These setup commands use the user login service and `<protected-root>/config/mac-local.json`. `mac:down` stops that route; it does not stop the system LaunchDaemons installed by the install-night recipe, whose configuration is under `Protected/config`. Before step 1, have the lead confirm which installation you have and supply the existing protected root. If you used install night, stop here: follow [the install-night guide](../INSTALL_NIGHT_OWNER_GUIDE.md) and ask the lead for a separately reviewed installed-service remote-access procedure. No such setup recipe is provided here; do not edit installed configuration or start a second host using these commands.

This is a one-time Cloudflare Tunnel and Cloudflare Access setup. Allow about
30 minutes. It lets your own computers reach Control Room without Tailscale,
while Cloudflare Access requires your login and authenticator-app MFA before
Control Room asks for its owner code.

## Before you begin

You need a domain already managed by Cloudflare, a Cloudflare Zero Trust team,
and `cloudflared` installed on the Mac running Control Room. The free Zero
Trust plan is enough.

You should be able to open the Cloudflare Zero Trust dashboard. If not, finish
the Cloudflare account and domain setup first.

## Set up the Cloudflare sign-in (about 20 minutes)

1. In **Settings → Authentication → Login methods**, add the login method you
   will use. Its account must use an authenticator app for two-step sign-in
   (for example, Google or GitHub with an authenticator app enabled).

   You should see that login method listed. If you only have emailed one-time
   PIN sign-in, add an authenticator-app method instead. If Cloudflare offers
   its own MFA setting, select **Authenticator application**.

2. In **Settings → Authentication → Global session timeout**, choose how long
   Cloudflare remembers a device, such as one month.

   You should see the saved timeout. If it does not save, check that you are
   editing the Zero Trust team rather than the normal domain dashboard.

3. Go to **Access → Applications → Add an application → Self-hosted**. Create
   an application with:

   - Domain: `your-private-name.your-domain.example`
   - Session duration: 24 hours
   - Policy: **Allow**; include only **Emails** = your exact email address
   - Login method: only the method from step 1

   You should see one self-hosted application and one narrow Allow policy. If
   you see an extra group, rule, or login method, remove it before continuing.

4. Open that application and copy its **Application Audience (AUD) Tag**. Find
   the team domain under **Settings → Custom pages**; it has the form
   `https://your-team.cloudflareaccess.com`.

   Keep both values ready for the next section. If you cannot find the AUD
   tag, reopen the self-hosted application rather than copying a value from a
   different Cloudflare application.

## Tell Control Room about the address

1. Stop Control Room:

   ```sh
   pnpm mac:down -- --protected-root <protected-root>
   ```

   You should see the local service stop. If it was already stopped, continue.

2. In `<protected-root>/config/mac-local.json`, add this top-level setting and
   replace every example value.

   ```json
   "remoteAccess": {
     "schema": "control-room.mac-local-remote-access/v1",
     "cloudflare": {
       "origin": "https://your-private-name.your-domain.example",
       "teamDomain": "https://your-team.cloudflareaccess.com",
       "audience": "<Application Audience (AUD) tag, 64 characters>",
       "ownerEmail": "you@example.com"
     }
   }
   ```

   You should have an exact HTTPS address with no path, port, final slash, or
   wildcard. If the file has an older `localOwnerSession.trustedOrigin`, remove
   it before starting Control Room.

## Create the tunnel on the Mac

1. Sign `cloudflared` in to Cloudflare:

   ```sh
   cloudflared tunnel login
   ```

   You should be asked to choose and approve your domain in a browser. If the
   browser does not open, use the link the command prints.

2. Create the tunnel:

   ```sh
   cloudflared tunnel create control-room
   ```

   You should see a tunnel ID and the path of a `.json` credentials file. Move
   that file into `<protected-root>/config/`, then make it private:

   ```sh
   chmod 600 <protected-root>/config/<TUNNEL-ID>.json
   ```

   If the command cannot find the file, use the exact path printed when the
   tunnel was created.

3. Let Control Room write the tunnel configuration:

   ```sh
   pnpm mac:remote-access write-cloudflared --protected-root <protected-root> --tunnel-id <TUNNEL-ID> --credentials-file <protected-root>/config/<TUNNEL-ID>.json
   ```

   You should see that it wrote `cloudflared.yml`. If it refuses the tunnel ID
   or credentials path, copy the exact UUID and absolute path from step 2.

4. Give the private address to the tunnel:

   ```sh
   cloudflared tunnel route dns control-room your-private-name.your-domain.example
   ```

   You should see a successful DNS route. If Cloudflare says the hostname is
   already in use, check the DNS record before retrying.

5. Check the saved configuration:

   ```sh
   pnpm mac:remote-access check --protected-root <protected-root>
   ```

   You should see only `PASS` lines. If you see `FAIL`, follow that line's
   instruction; do not start the tunnel until the check passes.

6. Start Control Room, then run the tunnel:

   ```sh
   pnpm mac:up -- --protected-root <protected-root>
   cloudflared tunnel --config <protected-root>/config/cloudflared.yml run control-room
   ```

   You should see the tunnel connect without opening a router port. Leave that
   terminal running while you want other-computer access.

## Test, sign out, and understand expiry

1. On another computer, open `https://your-private-name.your-domain.example`.
   Complete the Cloudflare login and authenticator-app MFA, then enter your
   Control Room owner code.

   You should reach Control Room. If you get Cloudflare's login page repeatedly,
   confirm the exact email and the one allowed login method in the Access
   application. If you get an owner-code page without Cloudflare first, stop
   and check the application domain and tunnel hostname.

2. Use **Sign out** in the Control Room menu to end the Control Room session
   and this site's Cloudflare sign-in in that browser.

   You should return to the sign-in flow. A wider Cloudflare login can still
   remember you, so a later visit may reach the owner-code page without MFA.

3. Sessions expire automatically: the Control Room session is at most 24 hours
   and an expired Cloudflare token is refused. For a lost computer, use **Zero
   Trust → My Team → Users → your user → Revoke session**. If your owner code
   may have been exposed, change it in `mac-local.json` and restart Control
   Room.

## If you also join worker machines

The generated tunnel requires Cloudflare Access across the whole hostname, including `/fleet/`. A worker connector has its own credential and cannot use that browser-token gate. Changing only the dashboard policy does not remove the tunnel's check; adding a manual fleet exception makes the prescribed configuration check fail.

This browser tunnel does not support the documented worker setup. Ask the lead for a separately reviewed fleet route and matching tunnel checks, or use a checked private Tailscale fleet route. Do not bypass Access on browser pages. Continue with [Join another machine as a worker](join-another-machine.md) only once the worker route is prepared.
