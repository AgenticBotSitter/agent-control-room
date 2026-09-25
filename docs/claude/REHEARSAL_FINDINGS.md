# Local rehearsal findings (W6)

**From:** Claude (lead). **To:** Codex. **Date:** 2026-09-24.

> Historical note: the optional SSH tunnel described below belonged to the
> initial rehearsal route. Revision 3.1 of `SECURE_DB_ROUTE.md` supersedes it
> for the real Mac installation. Current `mac:up` and `mac:down` do not start
> or stop a database tunnel.

## Merge alert (2026-09-25): don't let the task-provider loader fix regress

`origin/claude/mac-local-integration` currently has `mac-local-task-provider.ts`
reverted to `Object.getOwnPropertySymbols(value).length !== 0` in
`captureProvider` — the exact bug this doc's loader-fix section below
describes ("rejected every real module file"). A real `import()` namespace
carries `Symbol.toStringTag`, so that check refuses every real provider
module again, and `mac:tasks`/the task host will fail to start. `claude/
mac-local-support` at `3283bda9` (and every commit after) has the correct
fix: an `onlyModuleTag()` helper that allows exactly that one tag on a
null-prototype `Module` object, backed by a real-module-on-disk test in
`tests/mac-local-task-provider.test.ts`. When you next merge
`origin/claude/mac-local-support`, please keep that side of this specific
hunk (or re-apply it if the merge tool picks the other side) — this one is
easy to lose silently in a merge since both versions type-check and only
differ in whether they reject a real module at runtime.

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

## Real agent adapters (probe, 2026-09-24)

`node --import tsx scripts/mac-local/probe-adapters.ts <protected root> [codex|claude-code|hermes]` runs each pinned CLI through its real adapter, with no database. It runs three scenarios:

- a one-word task
- a cancel after 1 second
- a 1-second deadline

After each cancel or deadline, it checks that nothing survives in the agent's process group.

| Agent | Complete | Cancel | Deadline | Leftover processes |
|---|---|---|---|---|
| Codex | PASS | PASS | PASS | none |
| Claude | PASS (after fixes) | PASS | PASS | none |
| Hermes | PASS (`space-bunny-free` on `opencode-go`) | PASS | PASS | none |

Claude fixes on this branch. Without them, every real Claude task would have failed:

1. **Not logged in.** The adapter's environment had no `USER`, and the CLI finds the owner's sign-in in the login Keychain by account name. `USER` and `LOGNAME` now come from the OS account.
2. **Unknown line types.** The current CLI emits `rate_limit_event` on every run, and `system`/`thinking_tokens` whenever Sonnet thinks. Both are now accepted as content-free `informational` frames, with the same session and ordering rules as other lines. Other unknown types are still refused.
3. **Normal finish read as failure.** The current CLI reports `terminal_reason: "completed"` on success, and the decoder treated any terminal reason as a failure. `completed` now succeeds, and every other reason still fails.
4. **Opus by default.** The CLI default model is Opus, which would spend the owner's limited Opus allowance on every task. The worker now pins `--model sonnet` until W8 adds a per-task choice.

**Hermes model (owner decision, 2026-09-24):** Marvin uses **`space-bunny-free` on provider `opencode-go`**. The `cr` profile's old default (`stealth/ox-alpha` on OpenRouter) is retired, and that OpenRouter account has no credits.

- Set the Hermes worker's model and provider to these values in the protected configuration.
- Update the `cr` profile default to match, so manual runs agree with the worker.

## `mac:up` / `mac:down` (built, 2026-09-24)

`pnpm mac:up -- --protected-root <root>` (or `CONTROL_ROOM_PROTECTED_ROOT`) runs the order above and leaves the task host running in the background. Logs and pid files go in `<root>/runtime/` (0700; files 0600). `pnpm mac:down` stops the host (SIGTERM, 45 s drain, then kill), then the tunnel.

- **Tunnel.** It is optional and owner-held, in `<root>/config/tunnel.json` (0600):

  ```json
  {"schema":"control-room.mac-local-tunnel/v1","sshTarget":"user@host","localPort":15432,"remotePort":5432}
  ```

  The database in `mac-local.json` must be `127.0.0.1` on `localPort`. Without this file, `mac:up` assumes the database is reachable directly (rehearsal, or a tunnel managed elsewhere). With the file, `mac:up` reuses only a tunnel it started itself for those exact settings, and refuses any other listener on the port.
- **Safety.**
  - A recorded pid is signalled only if its full command line exactly matches what `mac:up` started for this protected root.
  - A failed start stops its own child.
  - A host that is alive but not serving is reported as a failure.
- **If `tunnel.json` becomes invalid while a tunnel is running,** `mac:down` leaves that pid alone and exits 1. Stop it by hand.
- **Known tension.** The task host needs all three agents `ready` (`requireMacLocalThreeAgentReadinessV1`). So a repin result of "blocked" for one agent still stops `mac:tasks`, even though the website alone would start with that agent shown as unavailable. The owner decides whether the task host should run with two agents.
- **Fixed the same day.** The task-provider loader rejected every real module file: a real `import()` result carries `Symbol.toStringTag`, and the loader refused any symbol. It now allows exactly that one tag, and a test loads a real module from disk.
