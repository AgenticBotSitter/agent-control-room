# E39 — installed queue composition

2026-09-06. Local implementation and compiled tests; no activation/deployment.

createInstalledNativeQueueFactories imports the locked pg-boss dependency and supplies
the existing producer and worker bootstrap factories. Construction does not open a pool,
run SQL or start a worker. Caller supplies a worker database factory; backend defaults
to PostgreSQL, with explicit PGlite used only by local tests. Existing task bootstrap
still requires explicit queue/worker configuration and all role checks before use.
Recovery capability is available but captured only when nativeQueueRecovery is enabled.

The VPS build exports server/nativeQueueFactories.js as a separate, unwired entrypoint.
Deployment packaging must retain package.json, pnpm-lock.yaml and installed production
dependencies; dist-vps alone is not a standalone executable. No settings or secrets are
loaded from the environment by this helper and no default activation is added.

Two integration issues were found and fixed:
- Upstream retry's declaration is an empty CommandResponse. The thin adapter now accepts
  unknown and explicitly checks an object with affected===1 at runtime; no type assertion
  or policy bypass is used to manufacture proof.
- The first compiled helper bundled pg-boss while leaving its pg dependency unresolved
  from the artifact. The Node build now externalizes the actual pg-boss package, preserving
  its installed package dependency boundary. The next build and imports succeed. This is
  normal server dependency packaging, not externalizing a nonexistent module/error.

Verification: TypeScript, targeted ESLint, whitespace and VPS build pass; 15 factory/adapter
unit checks pass. The three complete client-to-host journeys now use this installed helper
and pass with compiled bootstrap AND compiled helper/adapter code: online, reconnect,
lost response. All 35 compiled application regressions pass, including private asset
exclusions. pg-boss itself remains the installed locked package, not copied application code.

The new inert-construction test is in the normal posttest lifecycle. No downloads or
lockfile change in this block. Physical PostgreSQL pools, complete upstream schema
acceptance, real browser interaction, host configuration and authorized live-agent
acceptance remain open. This is not a deployment or real provider run.
