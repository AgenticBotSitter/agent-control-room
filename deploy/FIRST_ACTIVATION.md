# First private activation

This is the one-time website activation command. It deliberately combines only
the steps that are safe to combine: verify the two protected configuration files
match, create the first owner once, inspect the restricted database, and start
the existing private website launcher.

It does **not** create a database, run migrations, change a Cloudflare route,
create a role, start agents, or retry a failed owner enrollment.

Before running it, the operator must have prepared the reviewed dedicated
database, private Cloudflare Access application and route, protected owner
bootstrap input, and protected website settings. Both supplied `.mjs` paths and
the settings files they load must be canonical, operator-owned files readable
only by that operator.

Run this once from the pinned release after the owner has independently verified
the current Access identity and approved first-owner enrollment:

```sh
node scripts/activate-private-vps.mjs \
  --owner-bootstrap-configuration /APPROVED/owner-bootstrap-config.mjs \
  --configuration /APPROVED/operator-config.mjs \
  --start
```

The command checks that the database, tenant, workspace, owner identity, Access
issuer and Access audience are the same in both configurations before it can
write anything. It then performs the existing single-use owner bootstrap. If
that step fails or its result is uncertain, the command stops. Do **not** repeat
the command until the exact database has been privately reconciled; a lost
response may still mean the owner was created.

After a successful first activation, use the normal website launcher for later
controlled starts. Do not use this first-activation command as a supervisor or
as a restart policy.
