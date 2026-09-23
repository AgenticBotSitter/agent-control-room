# First private activation

This is the one-time private Control Room activation command. It combines only
the steps that are safe to combine: verify two protected configuration files
match, create the first owner once, inspect the restricted database, and start
the reviewed private host.

It does **not** create a database, run migrations, change Cloudflare, enroll a
worker, or retry a failed owner enrollment.

The included `deploy/operator-config.mjs` deliberately prepares the
**website-only** mode. The activation command can also start the complete
agent-task mode, but only when a separate owner-held, reviewed configuration
supplies its full private task, queue, result, and worker graph. A browser
setting or a copied website configuration cannot turn that mode on. Starting
the host is therefore not evidence that any agent is connected or allowed to
work.

## Complete agent-task host configuration

The release also contains `deploy/agent-task-operator-config.mjs`. It is the
fixed loader for the complete host, not a second product configuration. Before
activation, the operator creates one protected owner-only provider module
outside the release and points the service environment variable
`CONTROL_ROOM_AGENT_TASK_PROVIDER_FILE` at its absolute path. That private
module supplies the already-reviewed task, worker, result, review, queue and
native-TLS inputs. The loader rejects missing, relative, malformed, or changed
providers before a database, listener, queue, worker, or credential store is
touched.

The provider contains sensitive operational references and must never be
committed, uploaded, copied into the release, or placed in ordinary website
settings. The ordinary `operator-config.mjs` remains website-only. Use the
agent-task loader only after the full private input graph has been reviewed and
the operator has separately authorized the activation.

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
owner creation, the database check, and the selected host startup; it does not
reload a configuration file between stages.

If it fails or its result is uncertain, stop. Do not repeat it until the exact
database has been privately reconciled: a lost response may still mean the
owner was created. After successful first activation, use the ordinary website
launcher for controlled restarts rather than this one-time command.
