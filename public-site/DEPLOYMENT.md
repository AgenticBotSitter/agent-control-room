# Agent Control Room welcome website

Private source handoff for the public-facing welcome page. This is **not** the Control
Room application. The repository being private does not make a deployed website private.
Only the informational HTML/CSS are intended for eventual public serving.

Repository: https://github.com/AgenticBotSitter/agent-control-room-website

## Files and requirements

- `index.html`: welcome page, project goals, current status and contribution information.
- `styles.css`: responsive styling using system fonts.
- `README.md`: these deployment instructions; do not serve it as website content.

**There is no build step.** No Node, pnpm, Docker, database, API key or agent runtime is
required to serve this website. Use the VPS's existing static web server. The page has
no JavaScript, forms, analytics, external assets, private-app links or credentials.

## Johnny Five: obtain the files

Use your own authorized GitHub authentication. Do not request or copy another machine's
tokens, SSH keys or credential folders. A private repository requires permission to read
this specific repository; the link alone does not grant it.

From a parent directory you control, clone once:

```sh
git clone https://github.com/AgenticBotSitter/agent-control-room-website.git
cd agent-control-room-website
git status --short
git rev-parse HEAD
```

For a later approved update, from this same clone:

```sh
git status --short
git pull --ff-only
git rev-parse HEAD
```

Do not pull over local modifications. Record the deployed commit. No periodic poll,
scheduled pull, GitHub workflow or automatic deployment is needed.

## Confirm the destination before deploying

The owner has mentioned both `AgentControlRoom.com` and `agentcontrolroom.xyz`.
Confirm the intended domain and DNS control; neither is a default deployment target.
Inspect the existing virtual host and document root. Do not overwrite an existing
website, change unrelated DNS, or expose the private Control Room application.

Owner authorization to transfer this source is not blanket authority to change DNS,
install services, replace another site or deploy to an unconfirmed domain. Obtain the
exact target/deployment approval if it has not already been given to you.

## Deploy using the existing web server

1. Preserve the current virtual-host configuration and existing site release, if any.
2. Create a new release directory outside the Git clone. Copy **only** `index.html`
   and `styles.css` into it. Use normal read-only web-content permissions, not world
   writable permissions. Do not put `.git`, README, application files or credentials
   into the document root.
3. Configure the confirmed hostname to serve that directory with `index.html` as the
   index. Leave directory listing disabled. A static welcome page needs no reverse
   proxy to an app, database access, login endpoint or privileged process.
4. Use HTTPS with a certificate for the confirmed hostname. Configure security headers
   in the existing server: `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and
   `Content-Security-Policy: default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
   The HTML policy is intentionally restrictive; do not weaken it to load remote assets.
   Set HTML caching to revalidate and keep CSS caching short until filenames are versioned.
5. Validate the web-server configuration before reloading. Use its normal graceful reload,
   then verify the live site. Do not reboot the VPS or stop unrelated applications.

This is server-neutral guidance, not a command to install or replace the existing web
server. Adapt it to the server already in use and document the exact approved configuration.

## Verify and hand back

- The correct HTTPS domain loads the welcome page and `styles.css` successfully.
- Stylesheet responses use `text/css`; HTML uses `text/html` with UTF-8.
- Phone-width layout, keyboard focus, skip link and 200% text zoom remain usable.
- The page clearly says pre-alpha; forthcoming repository links are not fake buttons.
- No link points to a private application, host or login page.
- `/.git/config`, `/README.md` and directory listings expose no source or private files.
- Headers and certificate match the intended configuration; other hosted sites still work.

Send the owner the public URL, source commit, deployed file hashes, sanitized verification
results, and rollback instructions. If verification fails, restore the prior release using
the existing server's release mechanism. Do not delete the previous release until accepted.

## Actions budget and updates

GitHub Actions is to remain **disabled** for this repository. There are no workflows,
scheduled jobs, hosted builds, deployment actions or self-hosted runners to configure.
Use local checks and batch meaningful changes into a small number of pushes. Pull once
when a reviewed update is ready to deploy, not every few minutes.

Git transfers themselves do not consume Actions runner minutes; workflows triggered by
them can. Turning Actions off avoids runner-minute consumption for this repository.
Do not enable automation or paid usage without the owner's explicit approval.

## Content decisions still pending

The public source repository, contribution links, maintainer credit, contact information
and project license should be added only when confirmed and ready. This private handoff
does not license or publish the Control Room application's source. No third-party images,
fonts or script libraries are included in this static page.
