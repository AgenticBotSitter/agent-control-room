# VPS compiled handoff — preparation, not installation authority

Updated 2026-09-07. Intended reader: the Control Room integration owner and Johnny5.
GitHub publication and deployment remain paused. Do not run production setup from this
document. Current readiness is in BUILD_STATUS.md, not inferred from a compiled file.

## What the build supplies

| Output | Responsibility | Does importing it start work? |
|---|---|---|
| `dist-vps/client` | Private browser assets | No server or worker |
| `dist-vps/server/taskBootstrap.js` | Explicit configured task application startup | No; calling startup opens supplied databases and can start a configured worker |
| `dist-vps/server/taskHost.js` | Connects configured application/queue startup to existing loopback serving | No; explicit `start` can open databases, start a configured worker and bind a listener |
| `dist-vps/server/nativeQueueFactories.js` | Installed pg-boss producer/worker factories | No; factory operations are explicit |
| `dist-vps/server/nativeQueueInspection.js` | Exported `inspectInstalledNativeQueueSchema(database, signal)` | No; invocation reads the supplied SQL port |
| Remaining `dist-vps/server` files | Shared compiled modules, rendering and existing preparation/rehearsal entries | Preserve the whole output; do not cherry-pick entry files |

The output is **not a standalone installed service**. E80 supplies
`scripts/run-private-vps.mjs` as an explicit compiled-release launcher, but reviewed
operator configuration and successful resource-backed startup remain unqualified.
E81 verifies the launcher's compiled composition using injected disposable resources
and fake signals/listeners; direct CLI startup against real resources is still unqualified.
Its safe help command is `node scripts/run-private-vps.mjs --help`. Do not invoke its
configuration/start mode until the setup below is authorized and complete. See
[E80's operator contract](research/REUSE_E80_PRIVATE_VPS_LAUNCHER.md).
Keep the matching package manifest,
lockfile and resolved production dependencies alongside it. pg-boss is deliberately
external and resolves through its installed package and locked dependencies. Never copy
Mac `node_modules` to Linux. After approval, prepare dependencies on the target platform
from the exact lockfile; do not enable arbitrary package lifecycle scripts or upgrade
packages to make an installation pass. Retain third-party licenses/notices.

## Local verification available now

Do not substitute plain `vinext start`: its installed CLI defaults to `dist` and an
all-interface production bind. This private build uses `dist-vps` and the existing
loopback-only serving entry. [E60](research/REUSE_E60_TASK_HOST_COMPOSITION.md) now
connects application startup and serving. Trusted executable configuration and actual
resource provisioning remain unfinished; this is not an installation command.

From the repository root with already prepared dependencies:

```sh
node scripts/build-vps.mjs
pnpm run test:queue-compiled
node --import tsx --test tests/vps-built-*.test.mjs
```

The portable compiled-queue command selects the installed package and compiled startup,
queue factory and schema inspector. A missing compiled entry fails; it never silently
falls back to TypeScript source. It runs disposable PGlite simulations, including a
fresh task, reconnect, lost response and incomplete/mismatched schema inspection.
It opens no PostgreSQL service, listener or real agent. It is not Linux/Windows or
physical PostgreSQL acceptance merely because the command is shell-portable.

## Before production startup is permitted

### Website-only and optional second address

See [website delivery](WEBSITE_LOGIN_DELIVERY.md) for pending owner choices and live
acceptance. The existing launcher passes `prepared.configuration` unchanged to the
host; a second address needs no new launcher, process, database or queue. Assemble
these fields inside the existing trusted operator module, not a browser form or
public-site configuration. This illustrative fragment is deliberately incomplete
and contains no usable production identity or endpoint:

```js
// Within the separately reviewed createConfiguration result:
mode: "website-only",
configuration: {
  // Preserve the separately reviewed coordinator and other required settings.
  web: {
    // Preserve reviewed database, tenant/workspace, issuer, key loader and session settings.
    origin: "https://primary.example.invalid",
    audience: "PRIMARY_ACCESS_APPLICATION_AUDIENCE",
    secondaryAccess: {
      origin: "https://secondary.example.invalid",
      audience: "SECONDARY_ACCESS_APPLICATION_AUDIENCE"
    }
  }
}
```

Omit `secondaryAccess` until the alternate hostname and its permitted use are
approved. Both sites use the same configured issuer and identity mapping, with
distinct Access audiences. HTTPS origins must be exact and have no path or wildcard.
Website-only mode must omit native queue/worker, machine HTTP and native TLS setup;
it is not proof that agents can execute tasks. A database and the reviewed web and
coordinator resources are still required. Do not copy fixture keys or role grants.

Once specifically authorized, adapt the existing tunnel's hostname ingress rules
to the same loopback service. Each route must preserve or explicitly set its own
matching Host, enforce its own Access policy, and terminate unknown routes with a
catch-all rejection. Keep the public welcome page on its existing separate static
route and never route machine endpoints through the human websites. Retain the
existing supervisor; do not introduce a second app instance to serve the alias.

Acceptance must demonstrate, at the actual configured addresses:

- Anonymous requests and a nonmember identity cannot read private pages, APIs or assets.
- Each site accepts its own login; a credential from the other audience is rejected.
- The same owner sees the same project/task data on both sites; a restricted account
  cannot gain access by switching sites. Cross-origin writes remain denied.
- Reload/deep links, expiration, logout, MFA and remembered sessions behave as intended
  on desktop and phone. Observe cookies and Access-wide logout separately from the
  already-tested application token revocation; do not assume they are identical.
- The application origin is not Internet-accessible around Access, unknown Host
  values are rejected, and the public welcome page exposes no private data or links.

Before applying changes, retain the exact prior release and protected configuration
through the operator's existing backup procedure, never in a public repository.
If alias acceptance fails, disable its ingress, remove its optional application
configuration and restore the last accepted configuration/release using the existing
supervisor procedure. Verify the primary site and shared data still work. Do not
drop databases, undo unrelated schema changes or delete projects to roll back an alias.
This is a deployment handoff, not authorization to run it or a zero-downtime claim.

1. Prepare one approved private PostgreSQL primary on the Hostinger VPS, not AWS RDS.
   Apply reviewed schema/role preparation through a separately authorized operator.
2. Inspect the complete queue schema using the compiled inspector and a bounded,
   appropriately authorized read-only SQL port. Retain its sanitized result. No
   automatic repair is supplied; failed or incomplete probes stop acceptance. The
   caller must bound database queries: abort observation alone cannot interrupt an
   indefinitely blocked SQL port. Repeat inspection against the actual deployment
   candidate; an old result does not certify a changed database.
3. Supply distinct web, coordinator, result, evidence, session and queue-worker database
   identities as required by the selected full-host configuration. Operational roles
   do not gain schema-inspection privileges just to make the earlier step pass.
   Existing startup independently verifies role and scope gates; the inspection
   result does not bypass them or become request-supplied execution permission.
4. Supply reviewed owner login/origin configuration, public trust pins, exact enrollments,
   node/runtime settings and protected server-only secrets through the approved setup.
   Do not place credentials in Git, browser assets, this document or worker messages.
5. Complete the real PostgreSQL/pool rehearsal and one scoped real-agent task before
   treating simulated delivery as a working installation. Establish the actual service
   entrypoint, supervised lifecycle, private ingress and shutdown/drain behavior.
6. Validate backups with a restore, then canary/update/rollback. A compiled application
   alone does not supply those operating procedures or prove daily-use readiness.

Machine connectivity is separate from browser serving: the existing native HTTP handler
requires the actual authenticated TLS socket, not forwarded certificate headers. The
task host can now compose that endpoint only with explicit native HTTPS configuration,
as described in [E63](research/REUSE_E63_COMBINED_NATIVE_HOST.md). It does not provision
certificates or install/start itself. Real TLS and fleet acceptance remain outstanding.

The inspection entry is available to the future preparation runner; it is not invoked
automatically. E77 also exports `bindPrivateHostShutdown` from `taskHost.js` for explicit
operator-entrypoint use after startup. It calls existing host cleanup once for stop
signals and reports uncertainty on failure/timeout; it does not install a supervisor,
call process.exit, handle startup cancellation or register real handlers on import.
The inspection entry is not invoked
automatically by application startup. No new service manager, SSH copy protocol,
database authority or Hermes fork is introduced. Real installation commands and
host-specific secret provisioning remain gated work, not missing steps for a worker
to improvise.
