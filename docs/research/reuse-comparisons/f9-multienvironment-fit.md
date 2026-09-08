# RC10 actual application multi-environment preflight

2026-09-08. Source inspection only, following the existing miniature plugin fit
and actual distribution inventory. **Stopped before build or acquisition:** an
outDir-only override with the checkout as Vite root does not contain all writes
from installed vinext. No new pass count or license-selection result is earned.

## Exact inspected boundary

Read `f9-plugin-fit.md`, `f9-distribution-fit.md`, their existing research harness
boundary, `vite.vps.config.ts`, `scripts/build-vps.mjs`, and the relevant installed
vinext implementation. Installed package identity is `vinext@1.0.0-beta.2`.

| Local source | SHA256 |
| --- | --- |
| node_modules/vinext/dist/index.js | f17b6ef12f2f7341c7a07f92274d38bca70fb623c1af2691604405a92da67ff5 |
| vite.vps.config.ts | 0be17b2445d91721648500143d66b373796c1a5fec65380fece856641858f289 |
| scripts/build-vps.mjs | 0aa8746ae262eba1703eef667d0cf5483a440eb8a4dcc841d8f5b05ee32d12ae |

The application configuration explicitly builds client plus RSC/SSR, retains its
additional real runtime entrypoints, externalizes pg-boss and emits favicon.svg.
The build script uses Vite `createBuilder` and `buildApp`, not the vinext CLI or a
prerender listener. The earlier six-group miniature is not repeated here.

## Decisive preflight findings

1. **Hard-coded root-relative write.** `vinext/dist/index.js:2836–2852` installs
   `vinext:build-id` for builds. Its writeBundle handler unconditionally selects
   `path.join(root, "dist", "server")` and writes BUILD_ID once. It does not use
   client outDir, rscOutDir, ssrOutDir or Rollup output options. With the checkout as
   root, overriding the three advertised output directories still writes into the
   checkout's `dist/server`. No build was run to demonstrate a forbidden write.
2. **envFile:false alone is insufficient.** The config hook sets root at969 and
   directly calls `loadEnv(mode, config.envDir ?? root, "")` at975, then copies
   returned entries into process.env at976. It does not test Vite envFile there.
   A future isolated fixture must explicitly direct envDir to an owned empty
   directory as well as use envFile:false and a reviewed child environment. No
   dotenv file or credential was opened by this review.
3. **Possible dependency-adjacent write.** `vinext:og-font-patch` at3118–3129 has a
   transform filter for @vercel/og index.edge.js; when its expected embedded Yoga
   payload matches and yoga.wasm is absent, it writes beside the resolved module.
   Redirecting only build/cache directories does not contain that path. This is a
   conditional source finding, **not** evidence the actual app traverses this
   transform or that its current package is missing that file. A writable staging
   design must account for resolved dependency paths rather than assuming a
   symlink to the live node_modules is isolated.

Other inspected paths use actual output options for image assets and manifests;
their existence does not cancel the hard-coded write above. This is not a claim
that all vinext/transitive effects have been audited or that no public-API staging
approach can work. No plugin hook was removed or source patched to force a build.

## Consequence and next legitimate experiment

Do not run the existing build script, or a repository-root builder with merely
temporary outDirs, for this research packet. Root should select a bounded **owned
application staging root**, retain the same real application inputs and entrypoints,
and prove the resolved source/dependency/cache/output paths cannot write back to the
checkout. Setting Vite root to that staging directory also redirects the observed
BUILD_ID write without modifying upstream code. Explicit empty envDir and disabled
config-file loading must be reconciled with the required actual app configuration.
This is proposed follow-up work, not an executed fixture or completed proof.

Once containment is demonstrated, use separate actual rollup-plugin-license3.7.1
instances for client/RSC/SSR and its public output callbacks; do not create a new
generic graph scanner. Retain the outstanding checks from the prior packet:
full-text missing records, exact identity/text collisions across environments,
externals and their separate installation closure, copied Control Center code,
virtual/embedded code, emitted favicon/CSS/assets, and original project notices.
None was newly measured by this stopped preflight. There is still no legal or
redistribution clearance, and no evidence the real multi-environment plugin build
passes or fails.

## Resource/acquisition record

`df -k /private/tmp` reported 145,474,168 KiB available, above the 20 GiB floor.
No owned directory, download, dependency installation, compiled output, listener,
prerender run or other service was created. Zero acquired bytes and zero new
temporary files require cleanup. No global allocation measurement is claimed:
no acquisition/build proceeded to consume the authorized shared budget. Existing
distribution, dependency directories and other agents' roots were not modified.
Only this scoped research report was added.
