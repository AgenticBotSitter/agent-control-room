# Standalone build configuration separation

2026-09-06. Local implementation; no export, hosting, service or publication.

`scripts/build-vps.mjs` now loads `vite.vps.config.ts` directly. That configuration
retains the existing protected app, server entrypoints, output directories and external
pg-boss boundary without importing Sites metadata or the Sites plugin. The original
preview configuration delegates its explicit Node target to the same configuration;
it loads that definition lazily so ordinary previews do not construct an unused Node
plugin. Existing Sites settings, lockfile and hosting metadata are unchanged.

This removes a concrete private-configuration dependency from the public candidate's
build entrypoint. It does not make the whole repository public-safe, prove an isolated
export builds, or change application authorization. Shared styles, exhaustive path
classification, licenses and contributor setup remain unfinished.

Verification:

- Stage zero ready for runtime check; no native attempt.
- Standalone build completed in `dist-vps`; no listener started.
- Combined compiled/launcher/build-profile tests: 52 pass, zero failures/skips.
- TypeScript and targeted lint passed after the configuration changes.
- The final build-profile test additionally loads the actual standalone Vite config
  and checks its reported configuration dependencies exclude hosting metadata and the
  Sites plugin; all four focused profile tests and targeted lint pass afterward.
- No full default test lifecycle, hosted preview build or live deployment rerun claimed.

Generated local logs: `/private/tmp/cr-public-standalone-build.log` and
`/private/tmp/cr-public-standalone-tests.log`. They are not public release artifacts.
