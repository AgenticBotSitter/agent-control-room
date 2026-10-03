# Open Control Room on your phone

**Legacy checkout route only.** These setup commands use the user login service and `<protected-root>/config/mac-local.json`. `mac:down` stops that route; it does not stop the system LaunchDaemons installed by the install-night recipe, whose configuration is under `Protected/config`. Before step 1, have the lead confirm which installation you have and supply the existing protected root. If you used install night, stop here: follow [the install-night guide](../INSTALL_NIGHT_OWNER_GUIDE.md) and ask the lead for a separately reviewed installed-service remote-access procedure. No such setup recipe is provided here; do not edit installed configuration or start a second host using these commands.

Use this guide when your phone and Mac are on the same Tailscale network. This
does not make Control Room public on the internet.

## Before you begin

Install Tailscale on the Mac and phone, then sign in to the same tailnet on
both. In the Tailscale admin console, turn on **DNS → MagicDNS** and **HTTPS
certificates**.

You should see both devices listed as connected in Tailscale. If you do not,
finish the Tailscale sign-in before continuing.

## Turn on the private phone address

1. Stop Control Room:

   ```sh
   pnpm mac:down -- --protected-root <protected-root>
   ```

   You should see that the local service has stopped. If it says it was not
   running, continue.

2. In `<protected-root>/config/mac-local.json`, add this top-level setting.
   Replace the example values with your own Tailscale address and your own
   lower-case Tailscale login.

   ```json
   "remoteAccess": {
     "schema": "control-room.mac-local-remote-access/v1",
     "tailscale": {
       "origin": "https://your-mac.your-tailnet.ts.net",
       "ownerLogin": "you@example.com"
     }
   }
   ```

   You should have an exact HTTPS address with no path, port, final slash, or
   wildcard. If the file already has `localOwnerSession.trustedOrigin`, remove
   that older setting before starting Control Room.

3. Ask Control Room for the configured steps:

   ```sh
   pnpm mac:remote-access plan --protected-root <protected-root>
   ```

   You should see a **PHONE (Tailscale Serve...)** section and your private
   address. If you do not, recheck the spelling and placement of
   `remoteAccess` in the configuration file.

4. On the Mac, turn on Tailscale Serve:

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:3210
   tailscale serve status
   ```

   The status must show your `.ts.net` address pointing at
   `http://127.0.0.1:3210`. If it does not, do not use the address yet; rerun
   the first command and check that Tailscale is signed in.

   Never use `tailscale funnel`; it would publish the address to the internet.

5. Start Control Room:

   ```sh
   pnpm mac:up -- --protected-root <protected-root>
   ```

   You should see Control Room start normally. If it refuses to start, run the
   `plan` command in step 3 and correct the configuration it identifies.

## Open it and add it to your home screen

1. On the phone, open the `.ts.net` address in your browser and enter your
   Control Room owner code.

   You should see the Control Room home page. If the page does not open, make
   sure Tailscale is connected on the phone and use the exact address from
   `tailscale serve status`.

2. Add the page to the home screen.

   - On iPhone/iPad Safari: tap **Share**, then **Add to Home Screen**.
   - On Android Chrome: open the browser menu, then choose **Add to Home
     screen** or **Install app**.

   You should see a Control Room icon on the home screen. If the option is
   missing, open the address in Safari or Chrome rather than an in-app browser.

## Turn on notifications

1. Have the lead prepare the server's push configuration first. Without its VAPID public/private keys and subject, subscription is disabled; changing phone permissions cannot fix that.
2. Open Control Room from the home-screen icon, then **Settings → Phone notifications → Subscribe this browser**. Accept the permission prompt if one appears.
3. Look for **This browser is subscribed**, then choose **Send test**. The page may say the test was queued and receipt is unconfirmed; check the phone yourself. A saved subscription or queued test does not prove delivery.

If notifications are unavailable or the browser is unsupported, ask the lead to check server configuration and browser support. If the page says the subscription is not saved, subscribe again after the lead checks the connection. Only a permission refusal calls for changing the phone's notification permissions. Keep the page's message when asking for help.

## Turn it off later

On the Mac, run:

```sh
tailscale serve --https=443 off
```

You should no longer see the proxy in `tailscale serve status`. This turns off
phone access; it does not delete Control Room or your Tailscale account.
