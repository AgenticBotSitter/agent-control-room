# Local rehearsal findings (W6)

**From:** Claude (lead). **To:** Codex. **Date:** 2026-09-24.

I ran the real release build (`pnpm build`, then `mac:host` / `mac:tasks`) against a throwaway PostgreSQL 17 database on this Mac. Every problem below would have stopped the first real launch.

## Rehearse locally before touching the VPS

Use the same flow as the real Mac-local stack, with no tunnel and no VPS:

```
pnpm mac:rehearsal up <abs dir>     # PG17 on 127.0.0.1:15499, full migrations, 4 roles, protected root
pnpm mac:check-database <abs dir>/protected
pnpm mac:bootstrap-owner <abs dir>/protected
pnpm build && node scripts/mac-local/start-web-host.mjs --owner-attended --protected-root <abs dir>/protected
node scripts/mac-local/acceptance-w6.mjs --protected-root <abs dir>/protected
pnpm mac:rehearsal down <abs dir>
```

It uses the real installed agent CLIs for the pins. Iterate here, and use the VPS only for the final proof.

## Fixed on `claude/mac-local-support`

1. **Startup always failed** with `owner_trusted_local_enablement_invalid`. The loader returns the enablement with its derived `enablementDigest`, and startup passed that back into a validator that allowed exactly 4 fields. The validator now accepts an already-captured record only when its digest still matches, and tests cover a tampered digest and a swapped path.
2. **No owner existed.** Every page and API call returned `access_denied`: only the Cloudflare Access ceremony creates an owner, and Mac-local never ran it. New `pnpm mac:bootstrap-owner` creates the fixed local tenant, workspace and owner once. Re-runs are no-ops, and a different owner is refused (`src/web/v1/mac-local-owner-bootstrap.ts`).
3. **Every page returned 503** (`private_app_not_configured`). The page middleware sends each request through the installed private application, and Mac-local never installed one. `mac-local-serving.ts` now makes the renderer the handler, the same shape as the VPS host. On `start()` it installs one process-wide forwarder to the running Mac-local app, which returns "not configured" once that app has closed. Unauthenticated page requests return 401, and the test covers this.
4. **The W6 acceptance script** read the project back through an API route that Mac-local doesn't serve. It now checks the project list and the project page.

Result: W6 acceptance passes, except the restart check (which needs `mac:up`). A manual stop and start kept all projects.

## Still open: blocks `mac:tasks` (Codex)

`mac:tasks` fails with `mac_local_task_provider_invalid`. It loads `<protected>/runtime/task-provider.mjs`, and **nothing creates that file.** The provider has to export:

- `schema: MAC_LOCAL_TASK_PROVIDER_V1`
- `workerKinds: ["hermes", "claude-code", "codex"]`
- `createTaskApplication({ configuration, database, workerReadiness, databaseRoles })`

which returns `createMacLocalCurrentThreeAgentTaskApplicationV1(...)`, fed with:

- the Hermes delivery input
- the Claude and Codex `deliver` ports
- the restricted `web` / `coordinator` config, with `openDatabase` for the coordinator and results roles

Recommended shape:

- Put the real composition in a release-built module, for example `src/web/v1/mac-local-default-task-provider.ts`, added as an entry in `vite.vps.config.ts`.
- Have `mac:up` (or the provisioner) write `<protected>/runtime/task-provider.mjs` (mode 0600, directory 0700) as a one-line re-export of that built module.
- Keep all real logic in the repo, where it is reviewed and tested. The owner-held file only selects it.

W6 is not done until `mac:tasks` starts in rehearsal and `/api/v1/local-workers` lists three workers.

## `mac:up` order

1. `mac:repin` (exit 2 means stop)
2. Start the tunnel
3. `mac:check-database`
4. `mac:bootstrap-owner`
5. Write or check the task-provider file
6. Start `mac:tasks`
