# First private activation

This is the one-time private website activation command. It combines only the
steps that are safe to combine: verify two protected configuration files
match, create the first owner once, inspect the restricted database, and start
the existing private website launcher.

It does **not** create a database, run migrations, change Cloudflare, start an
agent, or retry a failed owner enrollment.

Before using it, prepare the reviewed dedicated database, private Cloudflare
Access application and route, protected owner-bootstrap input, and protected
website settings. Both supplied `.mjs` paths and the settings they load must
be canonical, operator-owned files readable only by that operator.

## About the six-digit code

Do not test a Cloudflare account MFA code against Control Room before the
private website is activated. The website must first reach its Cloudflare
Access sign-in page. Follow the authentication prompt shown there; do not
assume a code used for the Cloudflare dashboard is interchangeable with a
website sign-in code. A rejected code before the website is live does not
prove the authenticator setup failed.

After the owner has independently confirmed the current Access identity and
approved first-owner enrollment, run this once from the pinned release:

```sh
node scripts/activate-private-vps.mjs \
  --owner-bootstrap-configuration /APPROVED/owner-bootstrap-config.mjs \
  --configuration /APPROVED/operator-config.mjs \
  --start
```

The command checks that the database target, tenant, workspace, owner identity,
Access issuer, and Access audience match in both configurations before it can
write anything. It uses one fixed in-memory copy of those checked settings for
owner creation, the database check, and website startup; it does not reload a
configuration file between stages.

If it fails or its result is uncertain, stop. Do not repeat it until the exact
database has been privately reconciled: a lost response may still mean the
owner was created. After successful first activation, use the ordinary website
launcher for controlled restarts rather than this one-time command.
