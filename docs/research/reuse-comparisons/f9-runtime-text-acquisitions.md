# F9 runtime text acquisition and cleanup

2026-09-08; scoped continuation at base `4d204e6`. Owned root `/private/tmp/cr-f9-runtime-text.Jbd3kH`; initial disk free 139 GiB; final owned allocation 8.0 MiB (including private cache and four tiny staged texts). No app install or graph reinstall. One newly resolved package; no optional peer closure installed.

Command: `npm install --prefix /private/tmp/cr-f9-runtime-text.Jbd3kH --userconfig /dev/null --cache /private/tmp/cr-f9-runtime-text.Jbd3kH/cache --ignore-scripts --no-audit --no-fund --omit=optional --legacy-peer-deps @cyclonedx/cyclonedx-library@10.2.0` exited 0, added one package. Exact requested version was 10.2.0; generated manifest uses caret but actual resolved package is pinned below. This is not a repeatable future unpinned install instruction.

- Complete resolved package closure: `@cyclonedx/cyclonedx-library@10.2.0` only.
- Registry archive: `https://registry.npmjs.org/@cyclonedx/cyclonedx-library/-/cyclonedx-library-10.2.0.tgz`.
- npm integrity: `sha512-hGeo1XXM0zuIeTyzJihxPxnEOeNBmgZkuPRmTR28RktlAqF9xLneonHRCzahZHLgCq/LOmtCs5vyojJlnmJ87w==`.
- Generated package-lock SHA256: `28c9b1ec9bfd948f7c99b19778f04aa37667e096b927508a3ed43944ef596baa`.
- Actual gatherer implementation hash enforced before importing: `10a3bc2b7855dcfe85e8f3943d8bd2c512875d2cded34bc7df9ab51544891b36`.
- Public entry `@cyclonedx/cyclonedx-library/Contrib/License`; Apache-2.0; Node >=20.18.0. Prior source pin/test/license details are in `f9-text-fit.md` and `f9-text-acquisitions.json`; those texts were not reacquired.

Runtime commands: `node research/reuse-comparisons/f9-runtime-text-fit.mjs /private/tmp/cr-f9-runtime-text.Jbd3kH` (exit 0); `node research/reuse-comparisons/f9-runtime-text-exceptions.mjs /private/tmp/cr-f9-runtime-text.Jbd3kH` (initial receipt-envelope error exit 1, then one focused repair exit 0). Direct outputs retained in respective evidence JSON files. No application modules executed; actual collector library dependencies did execute. Only installed package manifests and license/README candidates were read.

Cleanup completed: exact owned root removed; subsequent `test ! -e /private/tmp/cr-f9-runtime-text.Jbd3kH` exited 0 and printed `owned-root-absent`. No background process/service was started. Retained third-party download bytes for this cohort: zero. Research scripts, hashes and sanitized evidence remain in the repository; no app or Git writes performed.
