# VPS compiled handoff — preparation, not installation authority

Updated 2026-09-06. Intended reader: the Control Room integration owner and Johnny5.
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
